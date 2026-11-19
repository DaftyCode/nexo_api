//! Protected environments. The interface names the active environment (`environment`, its
//! document id); when that environment is read-only the engine gets its name in
//! `readOnlyEnvironment` and refuses every request that may change data, scripts included.
//! A monitor cannot ask before sending changes: in an environment that asks first it gets
//! the name in `unattendedEnvironment` and sends none, unless the monitor allows them.
//! Only environments of the payload's workspace count, and clients cannot set the names.
use crate::Application;
use nexo_domain::{DocumentId, DocumentKind, Result, WorkspaceId};
use serde_json::{Map, Value};

/// Who sends: the person, who is asked first, or a monitor, which runs with nobody to ask.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Sender {
    Person,
    /// A monitor; `allow_changes` when it may send changes in an environment that asks first.
    Monitor {
        allow_changes: bool,
    },
}

impl Application {
    /// Names the protected environment for the engine, when the payload's one is.
    pub(crate) async fn protect_environment(
        &self,
        payload: &mut Map<String, Value>,
        sender: Sender,
    ) -> Result<()> {
        let workspace = payload.get("workspace").and_then(Value::as_str);
        let Some((name, protection)) = self
            .environment_protection(workspace, payload.get("environment"))
            .await?
        else {
            return Ok(());
        };
        let field = match (protection.as_str(), sender) {
            ("readonly", _) => "readOnlyEnvironment",
            (
                "confirm",
                Sender::Monitor {
                    allow_changes: false,
                },
            ) => "unattendedEnvironment",
            _ => return Ok(()),
        };
        payload.insert(field.into(), Value::String(name));
        Ok(())
    }

    /// The name and protection of environment `id` of `workspace`.
    async fn environment_protection(
        &self,
        workspace: Option<&str>,
        id: Option<&Value>,
    ) -> Result<Option<(String, String)>> {
        let (Some(workspace), Some(id)) = (workspace, id.and_then(Value::as_str)) else {
            return Ok(None);
        };
        let (Ok(workspace), Ok(id)) = (WorkspaceId::parse(workspace), DocumentId::parse(id)) else {
            return Ok(None);
        };
        // An environment deleted meanwhile protects nothing any more.
        let Ok(document) = self.workspaces.document(&id).await else {
            return Ok(None);
        };
        if document.kind != DocumentKind::Environment || document.workspace_id != workspace {
            return Ok(None);
        }
        let protection = document.value["protection"].as_str().unwrap_or("none");
        Ok(Some((document.name, protection.to_string())))
    }
}

#[cfg(test)]
mod tests {
    use super::Sender;
    use crate::testing::*;

    fn environment(id: &str, workspace: &str, value: Value) -> Document {
        Document {
            id: DocumentId::parse(id).unwrap(),
            workspace_id: WorkspaceId::parse(workspace).unwrap(),
            kind: DocumentKind::Environment,
            name: format!("Env {id}"),
            revision: 1,
            updated_at: 0,
            value,
        }
    }

    #[tokio::test]
    async fn the_engine_learns_the_read_only_environment_and_nothing_a_client_sends() {
        let (application, fake) = application();
        fake.documents.lock().unwrap().extend([
            environment(
                "prod",
                "local",
                json!({"values": [], "protection": "readonly"}),
            ),
            environment(
                "stage",
                "local",
                json!({"values": [], "protection": "confirm"}),
            ),
            environment(
                "other",
                "elsewhere",
                json!({"values": [], "protection": "readonly"}),
            ),
        ]);
        let request = |environment: &str| {
            json!({"workspace": "local", "environment": environment,
                "readOnlyEnvironment": "forged", "unattendedEnvironment": "forged",
                "request": {"url": "https://api.test"}})
        };
        for (environment, expected) in [
            ("prod", json!("Env prod")),
            ("stage", Value::Null),
            ("other", Value::Null),
            ("gone", Value::Null),
        ] {
            application
                .execute(Operation::Request, request(environment))
                .await
                .unwrap();
            let (_, sent) = fake.executed.lock().unwrap().pop().unwrap();
            assert_eq!(sent["readOnlyEnvironment"], expected, "{environment}");
            assert!(sent.get("unattendedEnvironment").is_none());
        }
        application
            .execute(
                Operation::Run,
                json!({"workspace": "local", "environment": "prod", "collection": {"item": []}}),
            )
            .await
            .unwrap();
        let (_, sent) = fake.executed.lock().unwrap().pop().unwrap();
        assert_eq!(sent["readOnlyEnvironment"], "Env prod");
    }

    #[tokio::test]
    async fn a_monitor_sends_no_changes_where_the_environment_asks_unless_allowed() {
        let (application, fake) = application();
        fake.documents.lock().unwrap().extend([
            environment(
                "prod",
                "local",
                json!({"values": [], "protection": "readonly"}),
            ),
            environment(
                "stage",
                "local",
                json!({"values": [], "protection": "confirm"}),
            ),
            environment("dev", "local", json!({"values": []})),
        ]);
        for (environment, allow_changes, field, expected) in [
            ("stage", false, "unattendedEnvironment", Some("Env stage")),
            ("stage", true, "unattendedEnvironment", None),
            ("prod", true, "readOnlyEnvironment", Some("Env prod")),
            ("dev", false, "unattendedEnvironment", None),
        ] {
            let mut payload = json!({"workspace": "local", "environment": environment})
                .as_object()
                .cloned()
                .unwrap();
            application
                .protect_environment(&mut payload, Sender::Monitor { allow_changes })
                .await
                .unwrap();
            assert_eq!(
                payload.get(field).and_then(Value::as_str),
                expected,
                "{environment} {allow_changes}"
            );
        }
    }
}
