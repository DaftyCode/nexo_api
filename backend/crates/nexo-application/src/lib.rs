//! Use cases depend only on domain types and outbound ports.
pub mod mcp;
pub mod operations;
pub mod ports;
use nexo_domain::{
    Document, DocumentId, DocumentKind, DocumentSummary, Error, Result, Revision, SecretSummary,
    Workspace, WorkspaceId, hosts::AllowedHosts,
};
use operations::{GitOperation, Operation};
use ports::{ExecutionGateway, SecretVault, VersionControl, WorkspaceRepository};
use serde_json::{Map, Value};
use std::sync::Arc;

/// Payload fields that only the backend may set; values sent by clients are discarded.
const INTERNAL_FIELDS: [&str; 6] = [
    "secretNames",
    "resolvedSecrets",
    "secretHosts",
    "resolvedOAuth2",
    "scope",
    "egressLoopbackPorts",
];
/// Fields that contain script source. Vault references there are never resolved, so an
/// imported collection cannot make secrets available to its scripts.
const SCRIPT_FIELDS: [&str; 5] = ["event", "prerequest", "tests", "script", "exec"];
/// History entries kept per workspace; older ones are deleted when a new one is saved.
pub const HISTORY_LIMIT: usize = 200;

/// Collects `{{vault:name}}` references outside script fields.
/// Vault entries of OAuth 2.0 tokens that requests reference: their access and ID tokens.
fn is_oauth2_token(name: &str) -> bool {
    name.starts_with("nexo-oauth2:") || name.starts_with("nexo-oauth2-id:")
}

pub fn vault_references(value: &Value) -> Vec<String> {
    fn visit(value: &Value, names: &mut Vec<String>) {
        match value {
            Value::String(text) => {
                // Same syntax as the runtime: `{{ vault:name }}`, surrounding spaces allowed.
                let mut rest = text.as_str();
                while let Some(index) = rest.find("{{") {
                    rest = &rest[index + 2..];
                    let Some(end) = rest.find("}}") else { break };
                    let inner = rest[..end].trim();
                    if let Some(name) = inner.strip_prefix("vault:").map(str::trim)
                        && !name.is_empty()
                        && name.len() <= 200
                        && !name.contains(['{', '}'])
                        && !names.iter().any(|n| n == name)
                    {
                        names.push(name.to_string());
                    }
                    rest = &rest[end + 2..];
                }
            }
            Value::Array(items) => items.iter().for_each(|item| visit(item, names)),
            Value::Object(map) => map
                .iter()
                .filter(|(key, _)| !SCRIPT_FIELDS.contains(&key.as_str()))
                .for_each(|(_, item)| visit(item, names)),
            _ => {}
        }
    }
    let mut names = Vec::new();
    visit(value, &mut names);
    names
}

pub struct Application {
    workspaces: Arc<dyn WorkspaceRepository>,
    executor: Arc<dyn ExecutionGateway>,
    secrets: Arc<dyn SecretVault>,
    git: Arc<dyn VersionControl>,
}
impl Application {
    pub fn new(
        workspaces: Arc<dyn WorkspaceRepository>,
        executor: Arc<dyn ExecutionGateway>,
        secrets: Arc<dyn SecretVault>,
        git: Arc<dyn VersionControl>,
    ) -> Self {
        Self {
            workspaces,
            executor,
            secrets,
            git,
        }
    }

    // Workspaces
    pub async fn workspaces(&self) -> Result<Vec<Workspace>> {
        self.workspaces.workspaces().await
    }
    pub async fn create_workspace(&self, name: &str) -> Result<Workspace> {
        self.workspaces
            .create_workspace(&Workspace::validate_name(name)?)
            .await
    }
    pub async fn rename_workspace(&self, id: &WorkspaceId, name: &str) -> Result<Workspace> {
        self.workspaces
            .rename_workspace(id, &Workspace::validate_name(name)?)
            .await
    }
    pub async fn delete_workspace(&self, id: &WorkspaceId) -> Result<()> {
        let workspaces = self.workspaces.workspaces().await?;
        if !workspaces.iter().any(|w| &w.id == id) {
            return Err(Error::NotFound);
        }
        if workspaces.len() == 1 {
            return Err(Error::Validation(
                "Keep at least one workspace; create another one first".into(),
            ));
        }
        self.workspaces.delete_workspace(id).await
    }
    async fn require_workspace(&self, id: &WorkspaceId) -> Result<()> {
        if self
            .workspaces
            .workspaces()
            .await?
            .iter()
            .any(|w| &w.id == id)
        {
            Ok(())
        } else {
            Err(Error::NotFound)
        }
    }

    // Documents
    pub async fn summaries(
        &self,
        workspace: &WorkspaceId,
        kind: Option<DocumentKind>,
    ) -> Result<Vec<DocumentSummary>> {
        self.require_workspace(workspace).await?;
        self.workspaces.summaries(workspace, kind).await
    }
    pub async fn documents(
        &self,
        workspace: &WorkspaceId,
        kind: Option<DocumentKind>,
    ) -> Result<Vec<Document>> {
        self.require_workspace(workspace).await?;
        self.workspaces.documents(workspace, kind).await
    }
    /// Every document of a workspace, with history and runs listed without their values:
    /// those grow with use and are loaded one at a time when opened.
    pub async fn listing(&self, workspace: &WorkspaceId) -> Result<Vec<Document>> {
        self.require_workspace(workspace).await?;
        let mut documents = Vec::new();
        for kind in DocumentKind::ALL {
            if kind.keeps_revisions() {
                documents.extend(self.workspaces.documents(workspace, Some(kind)).await?);
            } else {
                documents.extend(
                    self.workspaces
                        .summaries(workspace, Some(kind))
                        .await?
                        .into_iter()
                        .map(|summary| Document {
                            id: summary.id,
                            workspace_id: summary.workspace_id,
                            kind: summary.kind,
                            name: summary.name,
                            revision: summary.revision,
                            updated_at: summary.updated_at,
                            value: Value::Null,
                        }),
                );
            }
        }
        Ok(documents)
    }
    pub async fn document(&self, id: &DocumentId) -> Result<Document> {
        self.workspaces.document(id).await
    }
    pub async fn save_document(&self, document: Document) -> Result<Document> {
        document.validate()?;
        self.require_workspace(&document.workspace_id).await?;
        let (workspace, kind) = (document.workspace_id.clone(), document.kind);
        let saved = self.workspaces.save(document).await?;
        if kind == DocumentKind::History {
            self.workspaces
                .prune(&workspace, DocumentKind::History, HISTORY_LIMIT)
                .await?;
        }
        Ok(saved)
    }
    pub async fn delete_document(&self, id: &DocumentId, revision: i64) -> Result<()> {
        self.workspaces.delete(id, revision).await
    }
    pub async fn revisions(&self, id: &DocumentId) -> Result<Vec<Revision>> {
        self.workspaces.revisions(id).await
    }

    // Secrets
    /// Saves a secret's value, its allowed hosts (Postman's "allowed domains"; empty allows
    /// every host) or both. Without a value the stored one is kept.
    pub async fn put_secret(
        &self,
        name: &str,
        value: Option<&str>,
        allowed_hosts: Option<&[String]>,
    ) -> Result<()> {
        if value.is_none() && allowed_hosts.is_none() {
            return Err(Error::Validation(
                "Send a secret value, its allowed domains or both".into(),
            ));
        }
        let hosts = allowed_hosts.map(AllowedHosts::parse).transpose()?;
        self.secrets.put(name, value, hosts.as_ref()).await
    }
    pub async fn remove_secret(&self, name: &str) -> Result<()> {
        self.secrets.remove(name).await
    }
    pub async fn secrets(&self) -> Result<Vec<SecretSummary>> {
        self.secrets.secrets().await
    }

    pub async fn engine_healthy(&self) -> bool {
        self.executor.healthy().await
    }

    /// Runs an engine operation. Internal fields from clients are discarded, datasets are
    /// scoped to their workspace and vault references are resolved immediately before.
    pub async fn execute(&self, operation: Operation, payload: Value) -> Result<Value> {
        let mut payload = match payload {
            Value::Object(map) => map,
            Value::Null => Map::new(),
            _ => return Err(Error::Validation("Expected an object".into())),
        };
        for field in INTERNAL_FIELDS {
            payload.remove(field);
        }
        if let Some(workspace) = payload.get("workspace").and_then(Value::as_str) {
            let workspace = WorkspaceId::parse(workspace)?;
            self.require_workspace(&workspace).await?;
            if matches!(
                operation,
                Operation::DatasetQuery
                    | Operation::DatasetImport
                    | Operation::DatasetSchema
                    | Operation::DatasetDelete
                    | Operation::DatasetParse
            ) {
                payload.insert(
                    "scope".into(),
                    Value::String(format!("workspace:{workspace}")),
                );
            }
        } else if operation.needs_workspace() {
            return Err(Error::Validation(
                "Choose a workspace for this operation".into(),
            ));
        }
        if matches!(
            operation,
            Operation::Request
                | Operation::Run
                | Operation::Performance
                | Operation::Oauth2Token
                | Operation::Oauth2Authorize
        ) {
            let names = vault_references(&Value::Object(payload.clone()));
            if !names.is_empty() {
                let mut secrets = Map::new();
                for name in &names {
                    match self.secrets.resolve(name).await {
                        Ok(value) => {
                            secrets.insert(name.clone(), Value::String(value));
                        }
                        // A deleted OAuth 2.0 token (Manage Tokens, `nx.oauth2.reset`): the engine
                        // gets a new one ("Auto-fetch token") or sends the request without it.
                        Err(_) if is_oauth2_token(name) => {}
                        Err(error) => return Err(error),
                    }
                }
                payload.insert("resolvedSecrets".into(), Value::Object(secrets));
            }
        }
        self.executor
            .execute(operation, Value::Object(payload))
            .await
    }

    pub async fn git(&self, operation: GitOperation, payload: Value) -> Result<Value> {
        let workspace = WorkspaceId::parse(payload["workspace"].as_str().unwrap_or("local"))?;
        self.require_workspace(&workspace).await?;
        self.git.execute(&workspace, operation, payload).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use async_trait::async_trait;
    use serde_json::json;
    use std::sync::Mutex;

    #[derive(Default)]
    struct Fake {
        executed: Mutex<Vec<(String, Value)>>,
        pruned: Mutex<Vec<usize>>,
        workspaces: Mutex<Vec<Workspace>>,
    }
    fn workspace(id: &str) -> Workspace {
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
            _: &WorkspaceId,
            _: Option<DocumentKind>,
        ) -> Result<Vec<DocumentSummary>> {
            Ok(vec![])
        }
        async fn documents(
            &self,
            _: &WorkspaceId,
            _: Option<DocumentKind>,
        ) -> Result<Vec<Document>> {
            Ok(vec![])
        }
        async fn document(&self, _: &DocumentId) -> Result<Document> {
            Err(Error::NotFound)
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
        async fn prune(&self, _: &WorkspaceId, _: DocumentKind, keep: usize) -> Result<usize> {
            self.pruned.lock().unwrap().push(keep);
            Ok(0)
        }
    }
    #[async_trait]
    impl ExecutionGateway for Fake {
        async fn execute(&self, operation: Operation, payload: Value) -> Result<Value> {
            self.executed
                .lock()
                .unwrap()
                .push((operation.as_str().into(), payload));
            Ok(Value::Null)
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
    fn application() -> (Application, Arc<Fake>) {
        let fake = Arc::new(Fake::default());
        fake.workspaces.lock().unwrap().push(workspace("local"));
        (
            Application::new(fake.clone(), fake.clone(), fake.clone(), fake.clone()),
            fake,
        )
    }

    #[test]
    fn vault_references_skip_script_fields() {
        let payload = json!({
            "request": {
                "url": "https://api.test/{{vault:url_secret}}",
                "prerequest": "// {{vault:script_secret}}",
                "event": [{"script": {"exec": ["{{vault:event_secret}}"]}}]
            },
            "context": {"ancestors": [{"auth": {"bearer": [{"value": "{{ vault:token }}"}]}}]}
        });
        let mut names = vault_references(&payload);
        names.sort();
        assert_eq!(names, vec!["token", "url_secret"]);
    }

    #[tokio::test]
    async fn execute_strips_internal_fields_and_resolves_secrets() {
        let (application, fake) = application();
        application
            .execute(
                Operation::Request,
                json!({
                    "workspace": "local",
                    "request": {"url": "{{vault:key}}"},
                    "resolvedSecrets": {"forged": "x"},
                    "secretHosts": {"key": []},
                    "secretNames": ["other"],
                    "scope": "workspace:other",
                    "egressLoopbackPorts": [22]
                }),
            )
            .await
            .unwrap();
        let (_, payload) = fake.executed.lock().unwrap()[0].clone();
        assert_eq!(payload["resolvedSecrets"], json!({"key": "secret-of-key"}));
        assert!(payload.get("secretNames").is_none());
        assert!(
            payload.get("secretHosts").is_none(),
            "only the engine sets it"
        );
        assert!(payload.get("scope").is_none());
        assert!(payload.get("egressLoopbackPorts").is_none());
    }

    #[tokio::test]
    async fn secrets_need_a_value_or_valid_allowed_domains() {
        let (application, _) = application();
        assert!(application.put_secret("api", None, None).await.is_err());
        assert!(
            application
                .put_secret("api", None, Some(&["https://api.example.com/".into()]))
                .await
                .is_err()
        );
        application
            .put_secret("api", None, Some(&["*.example.com, api.test".into()]))
            .await
            .unwrap();
        application
            .put_secret("api", Some("v"), None)
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn a_deleted_oauth2_token_is_left_to_the_engine_but_other_secrets_must_exist() {
        let (application, fake) = application();
        application
            .execute(
                Operation::Request,
                json!({
                    "workspace": "local",
                    "request": {"url": "https://x", "auth": {"type": "oauth2", "oauth2": [
                        {"key": "accessToken", "value": "{{vault:nexo-oauth2:deleted}}"}
                    ]}},
                }),
            )
            .await
            .unwrap();
        let (_, payload) = fake.executed.lock().unwrap()[0].clone();
        assert_eq!(payload["resolvedSecrets"], json!({}));
        let error = application
            .execute(
                Operation::Request,
                json!({"workspace": "local", "request": {"url": "{{vault:deleted-key}}"}}),
            )
            .await
            .unwrap_err();
        assert!(error.to_string().contains("Secret not found"));
    }

    #[tokio::test]
    async fn datasets_are_scoped_to_an_existing_workspace() {
        let (application, fake) = application();
        application
            .execute(
                Operation::DatasetQuery,
                json!({"workspace": "local", "id": "d"}),
            )
            .await
            .unwrap();
        assert_eq!(
            fake.executed.lock().unwrap()[0].1["scope"],
            "workspace:local"
        );
        assert!(matches!(
            application
                .execute(
                    Operation::DatasetQuery,
                    json!({"workspace": "missing", "id": "d"})
                )
                .await,
            Err(Error::NotFound)
        ));
        assert!(
            application
                .execute(Operation::CookiesList, json!({}))
                .await
                .is_err(),
            "workspace data needs a workspace"
        );
    }

    #[tokio::test]
    async fn history_is_pruned_and_the_last_workspace_is_kept() {
        let (application, fake) = application();
        application
            .save_document(Document {
                id: DocumentId::parse("h").unwrap(),
                workspace_id: WorkspaceId::parse("local").unwrap(),
                kind: DocumentKind::History,
                name: "GET /".into(),
                revision: 0,
                updated_at: 0,
                value: json!({}),
            })
            .await
            .unwrap();
        assert_eq!(fake.pruned.lock().unwrap().as_slice(), [HISTORY_LIMIT]);
        let local = WorkspaceId::parse("local").unwrap();
        assert!(matches!(
            application.delete_workspace(&local).await,
            Err(Error::Validation(_))
        ));
        application.create_workspace("other").await.unwrap();
        application.delete_workspace(&local).await.unwrap();
    }

    #[tokio::test]
    async fn mcp_initializes_lists_tools_and_calls_use_cases() {
        let (application, fake) = application();
        let reply = application
            .mcp(json!({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": "2024-11-05"}}))
            .await;
        assert!(reply.session.is_some());
        assert_eq!(
            reply.body.unwrap()["result"]["protocolVersion"],
            "2024-11-05"
        );
        let notification = application
            .mcp(json!({"jsonrpc": "2.0", "method": "notifications/initialized"}))
            .await;
        assert_eq!(notification, mcp::Reply::default());
        let batch = application
            .mcp(json!([
                {"jsonrpc": "2.0", "id": 2, "method": "tools/list"},
                {"jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": {"name": "send_request", "arguments": {"request": {"url": "http://x"}}}},
                {"jsonrpc": "2.0", "id": 4, "method": "tools/call", "params": {"name": "send_request", "arguments": {}}},
                {"jsonrpc": "2.0", "id": 5, "method": "unknown"}
            ]))
            .await
            .body
            .unwrap();
        assert_eq!(batch[0]["result"]["tools"].as_array().unwrap().len(), 2);
        assert_eq!(batch[1]["result"]["isError"], false);
        assert_eq!(batch[2]["result"]["isError"], true);
        assert_eq!(batch[3]["error"]["code"], -32601);
        assert_eq!(fake.executed.lock().unwrap()[0].0, "request");
    }
}
