//! A fake of every port, recording what the use cases ask of it.
mod database;
pub(crate) mod datasources;

pub(crate) use crate::{
    Application, HISTORY_LIMIT,
    database::DATABASE_PAGE,
    mcp,
    operations::{GitOperation, Operation},
    ports::{
        self, DatabaseConnection, DocumentDatabase, ExecutionGateway, SecretVault, VersionControl,
        WorkspaceRepository,
    },
};
use async_trait::async_trait;
pub(crate) use nexo_domain::{
    Document, DocumentId, DocumentKind, DocumentSummary, Error, Result, Revision, SecretSummary,
    Workspace, WorkspaceId, hosts::AllowedHosts,
};
pub(crate) use serde_json::{Value, json};
pub(crate) use std::sync::{Arc, Mutex};

#[derive(Default)]
pub(crate) struct Fake {
    pub(crate) executed: Mutex<Vec<(String, Value)>>,
    pub(crate) pruned: Mutex<Vec<ports::Retention>>,
    pub(crate) workspaces: Mutex<Vec<Workspace>>,
    pub(crate) connections: Mutex<Vec<DatabaseConnection>>,
    pub(crate) finds: Mutex<Vec<ports::FindRequest>>,
    pub(crate) documents: Mutex<Vec<Document>>,
    pub(crate) writes: Mutex<Vec<(ports::WriteTarget, ports::DocumentWrite)>>,
    pub(crate) indexes: Mutex<Vec<ports::IndexChange>>,
    pub(crate) explains: Mutex<Vec<ports::ExplainRequest>>,
    pub(crate) imports: Mutex<Vec<(ports::WriteTarget, ports::ImportBatch)>>,
    pub(crate) aggregates: Mutex<Vec<ports::AggregateRequest>>,
    pub(crate) aggregate_writes: Mutex<Vec<ports::AggregateWrite>>,
    pub(crate) changes: Mutex<Vec<ports::CollectionChange>>,
    pub(crate) watches: Mutex<Vec<ports::WatchRequest>>,
}
pub(crate) fn workspace(id: &str) -> Workspace {
    Workspace {
        id: WorkspaceId::parse(id).unwrap(),
        name: id.into(),
    }
}
#[async_trait]
impl WorkspaceRepository for Fake {
    async fn workspaces(&self) -> Result<Vec<Workspace>> {
        Ok(self.workspaces.lock().unwrap().clone())
    }
    async fn create_workspace(&self, name: &str) -> Result<Workspace> {
        let created = workspace(name);
        self.workspaces.lock().unwrap().push(created.clone());
        Ok(created)
    }
    async fn rename_workspace(&self, id: &WorkspaceId, name: &str) -> Result<Workspace> {
        Ok(Workspace {
            id: id.clone(),
            name: name.into(),
        })
    }
    async fn delete_workspace(&self, id: &WorkspaceId) -> Result<()> {
        self.workspaces.lock().unwrap().retain(|w| &w.id != id);
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
            .map(|document| DocumentSummary {
                id: document.id,
                workspace_id: document.workspace_id,
                kind: document.kind,
                name: document.name,
                revision: document.revision,
                updated_at: document.updated_at,
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
            .filter(|d| &d.workspace_id == workspace && kind.is_none_or(|kind| d.kind == kind))
            .cloned()
            .collect())
    }
    async fn document(&self, id: &DocumentId) -> Result<Document> {
        self.documents
            .lock()
            .unwrap()
            .iter()
            .find(|document| &document.id == id)
            .cloned()
            .ok_or(Error::NotFound)
    }
    async fn save(&self, document: Document) -> Result<Document> {
        let mut documents = self.documents.lock().unwrap();
        documents.retain(|stored| stored.id != document.id);
        documents.push(document.clone());
        Ok(document)
    }
    async fn delete(&self, id: &DocumentId, _: i64) -> Result<()> {
        self.documents
            .lock()
            .unwrap()
            .retain(|stored| &stored.id != id);
        Ok(())
    }
    async fn revisions(&self, _: &DocumentId) -> Result<Vec<Revision>> {
        Ok(vec![])
    }
    async fn prune(
        &self,
        _: &WorkspaceId,
        _: DocumentKind,
        retention: ports::Retention,
    ) -> Result<usize> {
        self.pruned.lock().unwrap().push(retention);
        Ok(0)
    }
}
#[async_trait]
impl ExecutionGateway for Fake {
    async fn execute(&self, operation: Operation, payload: Value) -> Result<Value> {
        self.executed
            .lock()
            .unwrap()
            .push((operation.as_str().into(), payload.clone()));
        Ok(engine_answer(operation, &payload))
    }
}
#[async_trait]
impl SecretVault for Fake {
    async fn put(&self, _: &str, _: Option<&str>, _: Option<&AllowedHosts>) -> Result<()> {
        Ok(())
    }
    async fn remove(&self, _: &str) -> Result<()> {
        Ok(())
    }
    async fn resolve(&self, name: &str) -> Result<String> {
        if name.contains("deleted") {
            return Err(nexo_domain::Error::Validation(format!(
                "Secret not found: {name}"
            )));
        }
        Ok(format!("secret-of-{name}"))
    }
    async fn secrets(&self) -> Result<Vec<SecretSummary>> {
        Ok(vec![])
    }
}
#[async_trait]
impl VersionControl for Fake {
    async fn execute(&self, _: &WorkspaceId, _: GitOperation, _: Value) -> Result<Value> {
        Ok(Value::Null)
    }
}

/// What the engine answers in these tests: masking with the domain's rules (and a digest
/// that is not secret), a JSON response from `json.test`, and nothing else.
fn engine_answer(operation: Operation, payload: &Value) -> Value {
    match operation {
        Operation::MaskApply => {
            let rules = nexo_domain::masking::Rules::read(&json!({"rules": payload["rules"]}))
                .expect("valid rules");
            let digest = |input: &[u8]| [input.len() as u8; 32];
            let masker = nexo_domain::masking::Masker::new(&rules, &digest);
            let mut documents = payload["documents"].as_array().cloned().unwrap_or_default();
            documents
                .iter_mut()
                .for_each(|document| masker.document(document));
            json!({ "documents": documents })
        }
        Operation::Request
            if payload["request"]["url"]
                .as_str()
                .is_some_and(|url| url.contains("json.test")) =>
        {
            json!({"status": 200, "body": r#"{"email":"ana@corp.com","id":7}"#})
        }
        Operation::Request
            if payload["request"]["url"]
                .as_str()
                .is_some_and(|url| url.contains("text.test")) =>
        {
            json!({"status": 200, "body": "ana@corp.com"})
        }
        _ => Value::Null,
    }
}

pub(crate) fn application() -> (Application, Arc<Fake>) {
    let fake = Arc::new(Fake::default());
    fake.workspaces.lock().unwrap().push(workspace("local"));
    (
        Application::new(
            fake.clone(),
            fake.clone(),
            fake.clone(),
            fake.clone(),
            fake.clone(),
        ),
        fake,
    )
}
