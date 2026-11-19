//! SSH profiles reach the engine filled in. A route that names a profile (`{via: "ssh",
//! profile}`) gets its host, user and vault secrets in `sshProfiles` just before the operation
//! runs; clients cannot send them, and only profiles of the payload's workspace are read.
use crate::Application;
use nexo_domain::{DocumentId, DocumentKind, Error, Result, WorkspaceId};
use serde_json::{Map, Value, json};
use std::collections::BTreeSet;

/// The profiles that routes name anywhere in a payload, also inside the transport settings
/// that travel as JSON text (a request's, a collection item's).
pub(crate) fn profile_ids(value: &Value) -> BTreeSet<String> {
    let mut ids = BTreeSet::new();
    collect(value, &mut ids);
    ids
}

fn collect(value: &Value, ids: &mut BTreeSet<String>) {
    match value {
        Value::Object(map) => {
            if map.get("via").and_then(Value::as_str) == Some("ssh")
                && let Some(id) = map.get("profile").and_then(Value::as_str)
                && !id.trim().is_empty()
            {
                ids.insert(id.trim().to_string());
            }
            map.values().for_each(|child| collect(child, ids));
        }
        Value::Array(items) => items.iter().for_each(|child| collect(child, ids)),
        Value::String(text) if text.contains("\"ssh\"") => {
            if let Ok(parsed) = serde_json::from_str::<Value>(text) {
                collect(&parsed, ids);
            }
        }
        _ => {}
    }
}

fn text<'a>(value: &'a Value, field: &str) -> &'a str {
    value
        .get(field)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
}

impl Application {
    /// The profiles `payload` names, with their secrets, keyed by id; `None` when it names
    /// none. A profile that no longer exists is left out, and the engine says so.
    pub(crate) async fn ssh_profiles(
        &self,
        workspace: Option<&str>,
        payload: &Value,
    ) -> Result<Option<Value>> {
        let ids = profile_ids(payload);
        if ids.is_empty() {
            return Ok(None);
        }
        let workspace =
            WorkspaceId::parse(workspace.ok_or_else(|| {
                Error::Validation("Choose a workspace for this operation".into())
            })?)?;
        let mut profiles = Map::new();
        for id in ids {
            let Ok(document_id) = DocumentId::parse(&id) else {
                continue;
            };
            let Ok(document) = self.workspaces.document(&document_id).await else {
                continue;
            };
            if document.kind != DocumentKind::SshProfile || document.workspace_id != workspace {
                continue;
            }
            let value = &document.value;
            let auth = text(value, "auth");
            let mut profile = json!({
                "host": value["host"],
                "port": value["port"],
                "username": value["username"],
                "auth": auth,
            });
            let secret = self.secrets.resolve(text(value, "secret")).await?;
            profile[if auth == "key" {
                "privateKey"
            } else {
                "password"
            }] = Value::String(secret);
            let passphrase = text(value, "passphraseSecret");
            if auth == "key" && !passphrase.is_empty() {
                profile["passphrase"] = Value::String(self.secrets.resolve(passphrase).await?);
            }
            profiles.insert(id, profile);
        }
        Ok(Some(Value::Object(profiles)))
    }
}

#[cfg(test)]
mod tests {
    use crate::testing::*;

    fn profile(id: &str, workspace: &str, value: Value) -> Document {
        Document {
            id: DocumentId::parse(id).unwrap(),
            workspace_id: WorkspaceId::parse(workspace).unwrap(),
            kind: DocumentKind::SshProfile,
            name: "Bastion".into(),
            revision: 1,
            updated_at: 0,
            value,
        }
    }

    #[test]
    fn routes_name_profiles_also_inside_transport_settings_kept_as_text() {
        let transport = json!({"route": {"via": "ssh", "profile": "p2"}}).to_string();
        let payload = json!({
            "route": {"via": "ssh", "profile": " p1 "},
            "request": {"transport": transport},
            "collection": {"item": [{"nexoTransport": "{\"route\":{\"via\":\"ssh\",\"profile\":\"p3\"}}"}]},
            "other": {"via": "socks5", "profile": "not-ssh"},
            "text": "\"ssh\" but not JSON",
        });
        let ids: Vec<String> = super::profile_ids(&payload).into_iter().collect();
        assert_eq!(ids, ["p1", "p2", "p3"]);
    }

    #[tokio::test]
    async fn the_engine_gets_the_profiles_of_the_workspace_with_their_secrets() {
        let (application, fake) = application();
        fake.documents.lock().unwrap().extend([
            profile(
                "p1",
                "local",
                json!({"host": "bastion", "port": 22, "username": "ana",
                "auth": "password", "secret": "ssh-p1"}),
            ),
            profile(
                "p2",
                "local",
                json!({"host": "jump", "username": "ana", "auth": "key",
                "secret": "ssh-p2", "passphraseSecret": "ssh-p2-passphrase"}),
            ),
            profile(
                "p3",
                "other",
                json!({"host": "elsewhere", "username": "x",
                "auth": "password", "secret": "s"}),
            ),
        ]);
        let payload = json!({"routes": [
            {"via": "ssh", "profile": "p1"}, {"via": "ssh", "profile": "p2"},
            {"via": "ssh", "profile": "p3"}, {"via": "ssh", "profile": "gone"},
            {"via": "ssh", "profile": "not an id!"},
        ]});
        let profiles = application
            .ssh_profiles(Some("local"), &payload)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            profiles,
            json!({
                "p1": {"host": "bastion", "port": 22, "username": "ana", "auth": "password",
                    "password": "secret-of-ssh-p1"},
                "p2": {"host": "jump", "port": null, "username": "ana", "auth": "key",
                    "privateKey": "secret-of-ssh-p2", "passphrase": "secret-of-ssh-p2-passphrase"},
            })
        );
        assert_eq!(
            application
                .ssh_profiles(Some("local"), &json!({}))
                .await
                .unwrap(),
            None
        );
        let error = application.ssh_profiles(None, &payload).await.unwrap_err();
        assert_eq!(error.to_string(), "Choose a workspace for this operation");
    }
}
