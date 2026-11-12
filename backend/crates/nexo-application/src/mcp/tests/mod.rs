//! A workspace store and vault in memory for the MCP server; the other ports come from the
//! shared fake.
mod protocol;
mod share;

use crate::{
    Application,
    ports::{SecretVault, WorkspaceRepository},
    testing::Fake,
};
use async_trait::async_trait;
use nexo_domain::{
    Document, DocumentId, DocumentKind, DocumentSummary, Error, Result, Revision, SecretSummary,
    Workspace, WorkspaceId, hosts::AllowedHosts,
};
use serde_json::{Value, json};
use std::sync::{Arc, Mutex};

/// Workspaces, documents and a vault in memory.
#[derive(Default)]
struct Store {
    documents: Mutex<Vec<Document>>,
    secrets: Vec<(String, String)>,
    vault_locked: bool,
}
fn workspace(id: &str, name: &str) -> Workspace {
    Workspace {
        id: WorkspaceId::parse(id).unwrap(),
        name: name.into(),
    }
}
#[async_trait]
impl WorkspaceRepository for Store {
    async fn workspaces(&self) -> Result<Vec<Workspace>> {
        Ok(vec![workspace("local", "Main"), workspace("w2", "Team")])
    }
    async fn create_workspace(&self, name: &str) -> Result<Workspace> {
        Ok(workspace(name, name))
    }
    async fn rename_workspace(&self, id: &WorkspaceId, name: &str) -> Result<Workspace> {
        Ok(workspace(id.as_str(), name))
    }
    async fn delete_workspace(&self, _: &WorkspaceId) -> Result<()> {
        Ok(())
    }
    async fn summaries(
        &self,
        workspace: &WorkspaceId,
        kind: Option<DocumentKind>,
    ) -> Result<Vec<DocumentSummary>> {
        Ok(self
            .documents(workspace, kind)
            .await?
            .into_iter()
            .map(|d| DocumentSummary {
                id: d.id,
                workspace_id: d.workspace_id,
                kind: d.kind,
                name: d.name,
                revision: d.revision,
                updated_at: d.updated_at,
            })
            .collect())
    }
    async fn documents(
        &self,
        workspace: &WorkspaceId,
        kind: Option<DocumentKind>,
    ) -> Result<Vec<Document>> {
        Ok(self
            .documents
            .lock()
            .unwrap()
            .iter()
            .filter(|d| &d.workspace_id == workspace && kind.is_none_or(|k| d.kind == k))
            .cloned()
            .collect())
    }
    async fn document(&self, id: &DocumentId) -> Result<Document> {
        self.documents
            .lock()
            .unwrap()
            .iter()
            .find(|d| &d.id == id)
            .cloned()
            .ok_or(Error::NotFound)
    }
    async fn save(&self, document: Document) -> Result<Document> {
        Ok(document)
    }
    async fn delete(&self, _: &DocumentId, _: i64) -> Result<()> {
        Ok(())
    }
    async fn revisions(&self, _: &DocumentId) -> Result<Vec<Revision>> {
        Ok(vec![])
    }
    async fn prune(&self, _: &WorkspaceId, _: DocumentKind, _: usize) -> Result<usize> {
        Ok(0)
    }
}
#[async_trait]
impl SecretVault for Store {
    async fn put(&self, _: &str, _: Option<&str>, _: Option<&AllowedHosts>) -> Result<()> {
        Ok(())
    }
    async fn remove(&self, _: &str) -> Result<()> {
        Ok(())
    }
    async fn resolve(&self, name: &str) -> Result<String> {
        self.secrets
            .iter()
            .find(|(n, _)| n == name)
            .map(|(_, v)| v.clone())
            .ok_or(Error::NotFound)
    }
    async fn secrets(&self) -> Result<Vec<SecretSummary>> {
        if self.vault_locked {
            return Err(Error::Infrastructure("vault locked".into()));
        }
        Ok(self
            .secrets
            .iter()
            .map(|(name, _)| SecretSummary {
                name: name.clone(),
                allowed_hosts: vec![],
            })
            .chain([SecretSummary {
                name: "deleted".into(),
                allowed_hosts: vec![],
            }])
            .collect())
    }
}

fn document(id: &str, workspace: &str, kind: DocumentKind, name: &str, value: Value) -> Document {
    Document {
        id: DocumentId::parse(id).unwrap(),
        workspace_id: WorkspaceId::parse(workspace).unwrap(),
        kind,
        name: name.into(),
        revision: 1,
        updated_at: 0,
        value,
    }
}
/// A workspace with a collection, an environment, globals and two executions. The vault
/// value `s3cr3t-value` was pasted literally into the collection and a response.
fn application(vault_locked: bool) -> Application {
    let mut latest = document(
        "h2",
        "local",
        DocumentKind::History,
        "GET /orders",
        json!({
            "request": {"url": "https://api.test/orders",
                        "headers": [{"key": "Authorization", "value": "Bearer abc"}]},
            "response": {"status": 500, "body": "{\"error\":\"boom\",\"echo\":\"s3cr3t-value\"}"}
        }),
    );
    latest.updated_at = 20;
    let mut older = document(
        "h1",
        "local",
        DocumentKind::History,
        "GET /",
        json!({"response": {"status": 200}}),
    );
    older.updated_at = 10;
    let collection = json!({
        "info": {"name": "Shop"},
        "auth": {"type": "bearer", "bearer": [{"key": "token", "value": "literal-token"}]},
        "variable": [{"key": "note", "value": "uses s3cr3t-value here"}],
        "item": [{"name": "Orders", "item": [
            {"id": "r1", "name": "List orders", "request": {"method": "GET", "url": "{{base}}/orders"}}
        ]}]
    });
    let environment = json!({"values": [
        {"key": "base", "value": "https://api.test"},
        {"key": "password", "value": "hunter22"}
    ]});
    let store = Arc::new(Store {
        documents: Mutex::new(vec![
            document("c1", "local", DocumentKind::Collection, "Shop", collection),
            document("e1", "local", DocumentKind::Environment, "Dev", environment),
            document(
                "g1",
                "local",
                DocumentKind::Globals,
                "Globals",
                json!({"values": [{"key": "a", "value": "1"}]}),
            ),
            latest,
            older,
            document(
                "c2",
                "w2",
                DocumentKind::Collection,
                "Team API",
                json!({"info": {"name": "Team API"}, "item": []}),
            ),
        ]),
        secrets: vec![
            ("api".into(), "s3cr3t-value".into()),
            ("short".into(), "abc".into()),
        ],
        vault_locked,
    });
    let fake = Arc::new(Fake::default());
    Application::new(store.clone(), fake.clone(), store, fake.clone(), fake)
}
async fn call(application: &Application, method: &str, params: Value) -> Value {
    application
        .mcp(json!({"jsonrpc": "2.0", "id": 1, "method": method, "params": params}))
        .await
        .body
        .unwrap()
}
fn text(reply: &Value) -> String {
    reply["result"]["contents"][0]["text"]
        .as_str()
        .unwrap()
        .to_string()
}
