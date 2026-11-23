//! Sharing a collection (a new file, sealed with a new team key unless the person turns it
//! off), bringing a shared one into a workspace, and keeping one side of what both people
//! changed.
use super::{content::locked, location, new_id, text};
use crate::{Application, operations::Operation};
use nexo_domain::{Document, DocumentId, DocumentKind, Error, Result, WorkspaceId, shared};
use serde_json::{Map, Value, json};

/// Puts `content` in the element `id` of a collection (the collection itself for `""`),
/// keeping its items.
fn replace(collection: &mut Value, id: &str, content: &Value) -> bool {
    fn put(target: &mut Value, content: &Value) {
        let items = target.get("item").cloned();
        *target = content.clone();
        if let (Some(items), Value::Object(fields)) = (items, target) {
            fields.insert("item".into(), items);
        }
    }
    fn find(items: &mut Value, id: &str, content: &Value) -> bool {
        items.as_array_mut().into_iter().flatten().any(|item| {
            if item["id"].as_str() == Some(id) {
                put(item, content);
                true
            } else {
                find(&mut item["item"], id, content)
            }
        })
    }
    if id.is_empty() {
        put(collection, content);
        return true;
    }
    find(&mut collection["item"], id, content)
}

impl Application {
    /// Keeps the team key in the vault under a name that says what it opens.
    async fn keep_team_key(&self, name: &str, id: &DocumentId, key: &str) -> Result<String> {
        let short: String = id.as_str().chars().take(4).collect();
        let secret = format!("team: {} ({short})", name.replace(['{', '}'], ""));
        self.secrets.put(&secret, Some(key), None).await?;
        Ok(secret)
    }

    async fn save_link(&self, workspace: &WorkspaceId, name: &str, state: Value) -> Result<()> {
        let link = Document {
            id: new_id()?,
            workspace_id: workspace.clone(),
            kind: DocumentKind::SharedLink,
            name: name.into(),
            revision: 0,
            updated_at: 0,
            value: state,
        };
        self.workspaces.save(link).await.map(|_| ())
    }

    /// `shared.share`: writes a collection, and the environments chosen, to a new file.
    pub(super) async fn share_collection(
        &self,
        workspace: &WorkspaceId,
        payload: &Map<String, Value>,
    ) -> Result<Value> {
        let id = DocumentId::parse(text(payload, "collection"))?;
        let mut collection = self.workspaces.document(&id).await?;
        if &collection.workspace_id != workspace || collection.kind != DocumentKind::Collection {
            return Err(Error::NotFound);
        }
        if self.link_of(workspace, id.as_str()).await.is_ok() {
            return Err(Error::Validation(
                "This collection is already shared".into(),
            ));
        }
        let place = location(&text(payload, "path"))?;
        if self
            .executor
            .execute(Operation::SharedRead, json!({"location": place}))
            .await?["found"]
            == true
        {
            return Err(Error::Validation("A shared collection is already there: bring it in with Import → From a shared location".into()));
        }
        if shared::ensure_ids(&mut collection.value, || uuid::Uuid::new_v4().to_string()) {
            collection = self.workspaces.save(collection).await?;
        }
        let mut environments = Map::new();
        for env in payload
            .get("environments")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
        {
            let document = self.workspaces.document(&DocumentId::parse(env)?).await?;
            if &document.workspace_id == workspace && document.kind == DocumentKind::Environment {
                environments.insert(env.into(), json!(env));
            }
        }
        let key = match payload.get("encrypt") {
            Some(Value::Bool(false)) => None,
            _ => Some(
                self.executor
                    .execute(Operation::SharedKeyNew, json!({}))
                    .await?["key"]
                    .as_str()
                    .unwrap_or_default()
                    .to_owned(),
            ),
        };
        let key_name = match &key {
            Some(key) => Some(self.keep_team_key(&collection.name, &id, key).await?),
            None => None,
        };
        let mut state = json!({"collection": id.as_str(), "location": place, "keyName": key_name, "environments": environments, "conflicts": [], "error": null});
        let content = self.shared_content(&state, &collection).await?;
        let written = self.write_shared(&state, &content, &key, None).await?;
        state["version"] = written["version"].clone();
        state["stamp"] = written["stamp"].clone();
        state["base"] = content;
        self.save_link(workspace, &collection.name, state).await?;
        Ok(json!({"collection": id.as_str(), "key": key}))
    }

    /// `shared.link`: brings the shared collection at `path` into the workspace.
    pub(super) async fn link_shared(
        &self,
        workspace: &WorkspaceId,
        payload: &Map<String, Value>,
    ) -> Result<Value> {
        self.require_workspace(workspace).await?;
        let path = text(payload, "path");
        let place = location(&path)?;
        if self
            .links(workspace)
            .await?
            .iter()
            .any(|link| link.value["location"]["path"] == path.as_str())
        {
            return Err(Error::Validation(
                "This shared collection is already in this workspace".into(),
            ));
        }
        let key = Some(text(payload, "key")).filter(|key| !key.is_empty());
        if let Some(key) = &key {
            shared::parse_key(key)?;
        }
        let read = self
            .executor
            .execute(
                Operation::SharedRead,
                json!({"location": place, "resolvedKey": key}),
            )
            .await?;
        if read["found"] != true {
            return Err(Error::Validation(
                "There is no shared collection at that path".into(),
            ));
        }
        if read["locked"] == true {
            return Err(locked());
        }
        let content = read["content"].clone();
        let id = new_id()?;
        let name = content["collection"]["info"]["name"]
            .as_str()
            .filter(|name| !name.trim().is_empty())
            .unwrap_or("Shared collection")
            .to_owned();
        let collection = Document {
            id: id.clone(),
            workspace_id: workspace.clone(),
            kind: DocumentKind::Collection,
            name: name.clone(),
            revision: 0,
            updated_at: 0,
            value: content["collection"].clone(),
        };
        self.workspaces.save(collection).await?;
        let key_name = match &key {
            Some(key) => Some(self.keep_team_key(&name, &id, key).await?),
            None => None,
        };
        let mut state = json!({"collection": id.as_str(), "location": place, "keyName": key_name, "environments": {}, "conflicts": [], "error": null,
                               "version": read["version"], "stamp": read["stamp"], "base": content});
        let mut sync_state = state.clone();
        self.apply_environments(workspace, &mut sync_state, &content["environments"])
            .await?;
        state["environments"] = sync_state["environments"].clone();
        self.save_link(workspace, &name, state).await?;
        Ok(json!({"collection": id.as_str()}))
    }

    /// `shared.resolve`: keeps theirs, as the collection already has, or puts back mine.
    pub(super) async fn resolve_shared(
        &self,
        workspace: &WorkspaceId,
        payload: &Map<String, Value>,
    ) -> Result<Value> {
        let mut link = self
            .link_of(workspace, &text(payload, "collection"))
            .await?;
        let id = text(payload, "id");
        let mut conflicts = link.value["conflicts"]
            .as_array()
            .cloned()
            .unwrap_or_default();
        let at = conflicts
            .iter()
            .position(|conflict| conflict["id"] == id.as_str())
            .ok_or(Error::NotFound)?;
        let conflict = conflicts.remove(at);
        link.value["conflicts"] = Value::Array(conflicts);
        self.workspaces.save(link.clone()).await?;
        if text(payload, "keep") == "mine" {
            let mut collection = self
                .workspaces
                .document(&DocumentId::parse(
                    link.value["collection"].as_str().unwrap_or_default(),
                )?)
                .await?;
            if replace(&mut collection.value, &id, &conflict["mine"]) {
                self.save_document(collection).await?;
            }
        }
        self.shared_status(workspace).await
    }
}
