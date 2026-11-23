//! Keeping a shared collection and its file in step (C-01). What this Nexo shares is the
//! collection as a Git export shares it (credentials masked, settings of this computer left
//! out) and the environments chosen without their secret values. When nobody else wrote
//! since the last sync, this Nexo's changes are written; when someone did, both are joined
//! element by element (`shared::merge`), this Nexo keeps the joined collection with its own
//! credentials, and the file gets it, written only if it is still the version read.
use super::content::{
    element, locked, merge_environments, now, restore, restore_rows, shared_rows,
};
use crate::{Application, mcp, operations::Operation};
use nexo_domain::{Document, DocumentId, DocumentKind, Error, Result, WorkspaceId, shared};
use serde_json::{Value, json};

impl Application {
    /// What this Nexo shares of a link: the collection and the environments chosen.
    pub(super) async fn shared_content(
        &self,
        link: &Value,
        collection: &Document,
    ) -> Result<Value> {
        let mut environments = Vec::new();
        for (file_id, local) in link["environments"].as_object().into_iter().flatten() {
            let Ok(id) = DocumentId::parse(local.as_str().unwrap_or_default()) else {
                continue;
            };
            if let Ok(env) = self.workspaces.document(&id).await {
                environments.push(json!({"id": file_id, "name": env.name, "values": shared_rows(&env.value["values"])}));
            }
        }
        Ok(json!({"collection": mcp::shareable(&collection.value), "environments": environments}))
    }

    /// The team key of a link, from the vault.
    pub(super) async fn team_key(&self, link: &Value) -> Result<Option<String>> {
        let Some(name) = link["keyName"].as_str() else {
            return Ok(None);
        };
        self.secrets.resolve(name).await.map(Some).map_err(|_| {
            Error::Validation(format!("The team key {name} is not in the vault: bring the collection in again with its key"))
        })
    }

    pub(super) async fn write_shared(
        &self,
        link: &Value,
        content: &Value,
        key: &Option<String>,
        expected: Option<&str>,
    ) -> Result<Value> {
        let mut payload = json!({"location": link["location"], "content": content});
        if let Some(key) = key {
            payload["resolvedKey"] = json!(key);
        }
        if let Some(expected) = expected {
            payload["expected"] = json!(expected);
        }
        self.executor.execute(Operation::SharedWrite, payload).await
    }

    /// Brings the file and this Nexo's collection in step, once more when someone wrote in
    /// between; says whether this Nexo's collection or environments changed. With `join`
    /// off (after a save) only this Nexo's change is written: a file someone else changed
    /// waits for the next poll, which joins both and tells the interface, so that what it
    /// shows moves along with what the collection has.
    pub(super) async fn sync_link(&self, link: &Document, join: bool) -> Result<bool> {
        let _one_at_a_time = self.shared_sync.lock().await;
        match self.sync_once(link, join).await {
            Err(Error::Conflict) => {
                self.sync_once(&self.workspaces.document(&link.id).await?, join)
                    .await
            }
            other => other,
        }
    }

    async fn sync_once(&self, link: &Document, join: bool) -> Result<bool> {
        let mut state = link.value.clone();
        let collection = self
            .workspaces
            .document(&DocumentId::parse(
                state["collection"].as_str().unwrap_or_default(),
            )?)
            .await?;
        let key = self.team_key(&state).await?;
        let read = self
            .executor
            .execute(
                Operation::SharedRead,
                json!({"location": state["location"], "resolvedKey": key}),
            )
            .await?;
        if read["locked"] == true {
            return Err(locked());
        }
        if !join && read["found"] == true && read["version"] != state["version"] {
            // Someone else wrote: the next poll joins both.
            state["stamp"] = Value::Null;
            self.workspaces
                .save(Document {
                    value: state,
                    ..link.clone()
                })
                .await?;
            return Ok(false);
        }
        let ours = self.shared_content(&state, &collection).await?;
        let mut changed = false;
        let mut written = read.clone();
        if read["found"] != true || read["version"] == state["version"] {
            if read["found"] != true || ours != state["base"] {
                written = self
                    .write_shared(&state, &ours, &key, read["version"].as_str())
                    .await?;
                state["base"] = ours;
            }
        } else {
            let theirs = &read["content"];
            let merged = shared::merge(
                &state["base"]["collection"],
                &ours["collection"],
                &theirs["collection"],
            );
            let environments = merge_environments(
                &state["base"]["environments"],
                &ours["environments"],
                &theirs["environments"],
            );
            let local = restore(&merged.value, &collection.value);
            if local != collection.value {
                self.workspaces
                    .save(Document {
                        value: local,
                        ..collection.clone()
                    })
                    .await?;
                changed = true;
            }
            changed |= self
                .apply_environments(&collection.workspace_id, &mut state, &environments)
                .await?;
            let joined = json!({"collection": merged.value, "environments": environments});
            if joined != *theirs {
                written = self
                    .write_shared(&state, &joined, &key, read["version"].as_str())
                    .await?;
            }
            state["base"] = joined;
            let mut conflicts = state["conflicts"].as_array().cloned().unwrap_or_default();
            for conflict in merged.conflicts {
                // What this Nexo had, credentials included, to put back if the person keeps it.
                let mine = element(&collection.value, &conflict.id).unwrap_or(conflict.mine);
                conflicts.retain(|kept| kept["id"] != conflict.id.as_str());
                conflicts.push(json!({"id": conflict.id, "name": conflict.name, "mine": mine, "theirs": conflict.theirs}));
            }
            state["conflicts"] = Value::Array(conflicts);
        }
        state["version"] = written["version"].clone();
        state["stamp"] = written["stamp"].clone();
        state["error"] = Value::Null;
        state["synced"] = json!(now());
        self.workspaces
            .save(Document {
                value: state,
                ..link.clone()
            })
            .await?;
        Ok(changed)
    }

    /// The environments of the file in this Nexo: each one's secret values kept, and those a
    /// teammate added created.
    pub(super) async fn apply_environments(
        &self,
        workspace: &WorkspaceId,
        state: &mut Value,
        joined: &Value,
    ) -> Result<bool> {
        let mut changed = false;
        for env in joined.as_array().into_iter().flatten() {
            let file_id = env["id"].as_str().unwrap_or_default().to_owned();
            let local = state["environments"][&file_id]
                .as_str()
                .and_then(|id| DocumentId::parse(id).ok());
            match local {
                Some(id) => {
                    let Ok(mut document) = self.workspaces.document(&id).await else {
                        continue;
                    };
                    let values = restore_rows(&env["values"], &document.value["values"]);
                    if values != document.value["values"] {
                        document.value["values"] = values;
                        self.workspaces.save(document).await?;
                        changed = true;
                    }
                }
                None => {
                    let id = DocumentId::parse(uuid::Uuid::new_v4().to_string())?;
                    let name = env["name"]
                        .as_str()
                        .unwrap_or("Shared environment")
                        .to_owned();
                    let value = json!({"name": name, "values": env["values"]});
                    let document = Document {
                        id: id.clone(),
                        workspace_id: workspace.clone(),
                        kind: DocumentKind::Environment,
                        name,
                        revision: 0,
                        updated_at: 0,
                        value,
                    };
                    self.workspaces.save(document).await?;
                    state["environments"][&file_id] = json!(id.as_str());
                    changed = true;
                }
            }
        }
        Ok(changed)
    }
}
