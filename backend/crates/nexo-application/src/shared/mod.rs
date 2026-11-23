//! The collections shared by the team (C-01): a collection kept in a file every Nexo of the
//! team reads and writes, in a folder Google Drive, OneDrive or Dropbox sync or on a network
//! drive. Sharing writes the file (sealed with a new team key that goes to the vault, unless
//! the person turns it off); bringing one in reads it into the workspace. After every save of
//! the collection or of an environment shared with it, and when the file changed on the disk
//! (`shared.poll`, which only looks at its size and time), both are brought in step (sync.rs).
//! What both people changed differently waits for the person (`shared.resolve`).
mod content;
mod share;
mod sync;

use crate::{Application, operations::Operation};
use nexo_domain::{Document, DocumentId, DocumentKind, Error, Result, WorkspaceId, shared};
use serde_json::{Map, Value, json};

pub(super) fn text(payload: &Map<String, Value>, name: &str) -> String {
    payload
        .get(name)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_owned()
}

/// Where a payload says the file is: the URL of a server, or a path in a folder.
pub(super) fn location(payload: &Map<String, Value>) -> Result<Value> {
    let url = text(payload, "url");
    if !url.is_empty() {
        let lower = url.to_ascii_lowercase();
        let path = lower.split(['?', '#']).next().unwrap_or_default();
        if !(lower.starts_with("https://") || lower.starts_with("http://"))
            || !shared::is_shared_file(path)
        {
            return Err(Error::Validation(format!(
                "A shared collection on a server is an http or https URL ending in {}",
                shared::EXTENSION
            )));
        }
        return Ok(json!({"kind": "url", "url": url}));
    }
    let path = text(payload, "path");
    if !shared::is_shared_file(&path) {
        return Err(Error::Validation(format!(
            "A shared collection is a file ending in {}",
            shared::EXTENSION
        )));
    }
    Ok(json!({"kind": "folder", "path": path}))
}

/// The path or the URL of a location.
pub(super) fn place(location: &Value) -> &str {
    location["path"]
        .as_str()
        .or(location["url"].as_str())
        .unwrap_or_default()
}

pub(super) fn new_id() -> Result<DocumentId> {
    DocumentId::parse(uuid::Uuid::new_v4().to_string())
}

/// What the interface shows of a link.
fn status(link: &Document) -> Value {
    let value = &link.value;
    let conflicts: Vec<Value> = value["conflicts"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|conflict| json!({"id": conflict["id"], "name": conflict["name"]}))
        .collect();
    let environments: Vec<Value> = value["environments"]
        .as_object()
        .into_iter()
        .flatten()
        .map(|(_, id)| id.clone())
        .collect();
    json!({"collection": value["collection"], "name": link.name, "path": place(&value["location"]),
           "kind": value["location"]["kind"],
           "encrypted": !value["keyName"].is_null(), "environments": environments,
           "conflicts": conflicts, "error": value["error"], "synced": value["synced"]})
}

impl Application {
    /// `shared.*` from the interface.
    pub(crate) async fn shared(
        &self,
        operation: Operation,
        payload: Map<String, Value>,
    ) -> Result<Value> {
        if operation.is_shared_file() {
            return Err(Error::Validation("This operation is Nexo's own".into()));
        }
        let workspace = WorkspaceId::parse(text(&payload, "workspace"))?;
        match operation {
            Operation::SharedShare => self.share_collection(&workspace, &payload).await,
            Operation::SharedLink => self.link_shared(&workspace, &payload).await,
            Operation::SharedPoll => {
                let opening = payload.get("opening").and_then(Value::as_bool) == Some(true);
                self.poll_shared(&workspace, opening).await
            }
            Operation::SharedResolve => self.resolve_shared(&workspace, &payload).await,
            Operation::SharedStatus => self.shared_status(&workspace).await,
            _ => {
                let link = self
                    .link_of(&workspace, &text(&payload, "collection"))
                    .await?;
                match operation {
                    Operation::SharedSync => {
                        if let Err(error) = self.sync_link(&link, true).await {
                            self.record_shared_error(&link.id, &error).await;
                            return Err(error);
                        }
                    }
                    Operation::SharedUnlink => {
                        self.workspaces.delete(&link.id, link.revision).await?
                    }
                    _ => return Ok(json!({"key": self.team_key(&link.value).await?})),
                }
                self.shared_status(&workspace).await
            }
        }
    }

    pub(super) async fn links(&self, workspace: &WorkspaceId) -> Result<Vec<Document>> {
        self.workspaces
            .documents(workspace, Some(DocumentKind::SharedLink))
            .await
    }

    pub(super) async fn link_of(
        &self,
        workspace: &WorkspaceId,
        collection: &str,
    ) -> Result<Document> {
        self.links(workspace)
            .await?
            .into_iter()
            .find(|link| link.value["collection"] == collection)
            .ok_or(Error::NotFound)
    }

    pub(super) async fn shared_status(&self, workspace: &WorkspaceId) -> Result<Value> {
        Ok(json!({"links": self.links(workspace).await?.iter().map(status).collect::<Vec<_>>()}))
    }

    async fn record_shared_error(&self, id: &DocumentId, error: &Error) {
        if let Ok(mut link) = self.workspaces.document(id).await {
            link.value["error"] = json!(error.to_string());
            let _ = self.workspaces.save(link).await;
        }
    }

    /// `shared.poll`: brings in step the links whose file changed on the disk, and those
    /// that failed or were left behind last time. Only the size and time of each file are
    /// read when nothing did; a server is asked only when the workspace opens (`opening`) or
    /// after a save found a teammate's change there, never on a schedule.
    async fn poll_shared(&self, workspace: &WorkspaceId, opening: bool) -> Result<Value> {
        let links = self.links(workspace).await?;
        let paths: Vec<Value> = links
            .iter()
            .filter(|link| link.value["location"]["kind"] != "url")
            .map(|link| link.value["location"]["path"].clone())
            .collect();
        let stamps = if paths.is_empty() {
            json!({})
        } else {
            self.executor
                .execute(Operation::SharedStat, json!({"paths": paths}))
                .await?["stamps"]
                .clone()
        };
        let mut changed = Vec::new();
        for link in &links {
            let calm = link.value["error"].is_null();
            let quiet = if link.value["location"]["kind"] == "url" {
                !opening && !link.value["stamp"].is_null()
            } else {
                let path = link.value["location"]["path"].as_str().unwrap_or_default();
                stamps[path] == link.value["stamp"]
            };
            if quiet && calm {
                continue;
            }
            match self.sync_link(link, true).await {
                Ok(true) => changed.push(link.value["collection"].clone()),
                Ok(false) => {}
                Err(error) => self.record_shared_error(&link.id, &error).await,
            }
        }
        Ok(json!({"changed": changed, "links": self.shared_status(workspace).await?["links"]}))
    }

    /// After a collection or an environment is saved: its shared file gets the change, unless
    /// a teammate's change got there first, which the next poll joins.
    pub(crate) async fn shared_saved(&self, saved: &Document) {
        if !matches!(
            saved.kind,
            DocumentKind::Collection | DocumentKind::Environment
        ) {
            return;
        }
        let Ok(links) = self.links(&saved.workspace_id).await else {
            return;
        };
        for link in links.iter().filter(|link| {
            link.value["collection"] == saved.id.as_str()
                || link.value["environments"]
                    .as_object()
                    .is_some_and(|envs| envs.values().any(|id| id == saved.id.as_str()))
        }) {
            if let Err(error) = self.sync_link(link, false).await {
                self.record_shared_error(&link.id, &error).await;
            }
        }
    }

    /// A deleted collection stops being shared; its file stays for the team.
    pub(crate) async fn shared_deleted(&self, document: &Document) -> Result<()> {
        if document.kind != DocumentKind::Collection {
            return Ok(());
        }
        if let Ok(link) = self
            .link_of(&document.workspace_id, document.id.as_str())
            .await
        {
            self.workspaces.delete(&link.id, link.revision).await?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests;
