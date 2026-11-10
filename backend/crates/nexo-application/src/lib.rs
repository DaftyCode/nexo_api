//! Use cases depend only on domain types and outbound ports.
mod database_writes;
pub mod mcp;
mod mcp_content;
pub mod operations;
pub mod payloads;
pub mod ports;
use nexo_domain::{
    Document, DocumentId, DocumentKind, DocumentSummary, Error, Result, Revision, SecretSummary,
    Workspace, WorkspaceId, hosts::AllowedHosts,
};
use operations::{GitOperation, Operation};
use ports::{
    DatabaseConnection, DocumentDatabase, ExecutionGateway, SecretVault, VersionControl,
    WorkspaceRepository,
};
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
/// MongoDB queries kept in a workspace's query history.
pub const QUERY_HISTORY_LIMIT: usize = 100;
/// Documents in a page of MongoDB results when the client does not say.
const DATABASE_PAGE: u64 = 50;

/// Collects `{{vault:name}}` references outside script fields.
/// Vault entries of OAuth 2.0 tokens that requests reference: their access and ID tokens.
fn is_oauth2_token(name: &str) -> bool {
    name.starts_with("nexo-oauth2:") || name.starts_with("nexo-oauth2-id:")
}

/// Replaces `{{vault:name}}` references in `text` with their values. In a URI the values are
/// percent-encoded, so a user name such as `ana@corp` cannot change where it connects.
fn replace_vault(text: &str, values: &[(String, String)], in_uri: bool) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(start) = rest.find("{{") {
        out.push_str(&rest[..start]);
        let after = &rest[start + 2..];
        let Some(end) = after.find("}}") else {
            rest = &rest[start..];
            break;
        };
        let inner = after[..end].trim();
        let value = inner
            .strip_prefix("vault:")
            .map(str::trim)
            .and_then(|name| values.iter().find(|(n, _)| n == name));
        match value {
            Some((_, value)) if in_uri => out.push_str(&uri_encode(value)),
            Some((_, value)) => out.push_str(value),
            None => out.push_str(&rest[start..start + 2 + end + 2]),
        }
        rest = &after[end + 2..];
    }
    out.push_str(rest);
    out
}

/// Percent-encodes what would change the meaning of a connection URI.
fn uri_encode(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric() || b"-._~!$&'()*+;=".contains(&byte) {
            out.push(byte as char);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

/// Removes secret values (also percent-encoded) from an error before it leaves.
fn redact_error(error: Error, values: &[(String, String)]) -> Error {
    let redact = |mut message: String| {
        for (_, value) in values {
            // Very short values would turn ordinary words into noise.
            if value.chars().count() >= 3 {
                message = message
                    .replace(value.as_str(), "[redacted]")
                    .replace(&uri_encode(value), "[redacted]");
            }
        }
        message
    };
    match error {
        Error::Validation(message) => Error::Validation(redact(message)),
        Error::Unavailable(message) => Error::Unavailable(redact(message)),
        Error::Infrastructure(message) => Error::Infrastructure(redact(message)),
        other => other,
    }
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
    database: Arc<dyn DocumentDatabase>,
}
impl Application {
    pub fn new(
        workspaces: Arc<dyn WorkspaceRepository>,
        executor: Arc<dyn ExecutionGateway>,
        secrets: Arc<dyn SecretVault>,
        git: Arc<dyn VersionControl>,
        database: Arc<dyn DocumentDatabase>,
    ) -> Self {
        Self {
            workspaces,
            executor,
            secrets,
            git,
            database,
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
    /// Every document of a workspace, with request history and runs listed without their
    /// values: those grow with use and are loaded one at a time when opened.
    pub async fn listing(&self, workspace: &WorkspaceId) -> Result<Vec<Document>> {
        self.require_workspace(workspace).await?;
        let mut documents = Vec::new();
        for kind in DocumentKind::ALL {
            if kind.listed_whole() {
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
        if kind == DocumentKind::DatabaseChange {
            self.workspaces
                .prune(
                    &workspace,
                    DocumentKind::DatabaseChange,
                    database_writes::CHANGE_LIMIT,
                )
                .await?;
        }
        if kind == DocumentKind::QueryHistory {
            self.workspaces
                .prune(&workspace, DocumentKind::QueryHistory, QUERY_HISTORY_LIMIT)
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
        // Checked against the operation's type before anything else reads it.
        let Value::Object(mut payload) = payloads::validate(operation, Value::Object(payload))?
        else {
            return Err(Error::Validation("Expected an object".into()));
        };
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
        if operation.is_database() {
            return self.database(operation, Value::Object(payload)).await;
        }
        if matches!(
            operation,
            Operation::Request
                | Operation::Run
                | Operation::Performance
                | Operation::Oauth2Token
                | Operation::Oauth2Authorize
                // Credentials of MQTT and Kafka connections may come from the vault.
                | Operation::RealtimeConnect
        ) {
            // The contents of chosen files are sent as they are: no references are read in
            // them, and they are not copied to look.
            let files = payload.remove("files");
            let names = vault_references(&Value::Object(payload.clone()));
            if let Some(files) = files {
                payload.insert("files".into(), files);
            }
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

    /// Runs a document database operation. The connection's vault references are resolved
    /// here, the allowed domains of those secrets go along to be checked against every
    /// server, and their values never come back in an error.
    async fn database(&self, operation: Operation, payload: Value) -> Result<Value> {
        let mut values = Vec::new();
        let result = self.run_database(operation, payload, &mut values).await;
        result.map_err(|error| redact_error(error, &values))
    }

    async fn run_database(
        &self,
        operation: Operation,
        payload: Value,
        values: &mut Vec<(String, String)>,
    ) -> Result<Value> {
        fn read<T: serde::de::DeserializeOwned>(payload: Value) -> Result<T> {
            serde_json::from_value(payload).map_err(|error| Error::Validation(error.to_string()))
        }
        fn object(value: Option<Map<String, Value>>) -> Option<Value> {
            value.map(Value::Object)
        }
        fn answer<T: serde::Serialize>(value: T) -> Result<Value> {
            serde_json::to_value(value).map_err(|error| Error::Infrastructure(error.to_string()))
        }
        if operation.is_database_write() {
            return self.database_write(operation, payload, values).await;
        }
        let database = &self.database;
        match operation {
            Operation::MongoTest => {
                let payload: payloads::MongoConnectionPayload = read(payload)?;
                let connection = self.resolve_connection(payload.connection, values).await?;
                answer(database.test(connection).await?)
            }
            Operation::MongoDatabases => {
                let payload: payloads::MongoConnectionPayload = read(payload)?;
                let connection = self.resolve_connection(payload.connection, values).await?;
                Ok(
                    serde_json::json!({ "databases": answer(database.databases(connection).await?)? }),
                )
            }
            Operation::MongoCollections => {
                let payload: payloads::MongoDatabasePayload = read(payload)?;
                let connection = self.resolve_connection(payload.connection, values).await?;
                let collections = database.collections(connection, &payload.database).await?;
                Ok(serde_json::json!({ "collections": answer(collections)? }))
            }
            Operation::MongoStats => {
                let payload: payloads::MongoCollectionPayload = read(payload)?;
                let connection = self.resolve_connection(payload.connection, values).await?;
                answer(
                    database
                        .stats(connection, &payload.database, &payload.collection)
                        .await?,
                )
            }
            Operation::MongoFind => {
                let payload: payloads::MongoFindPayload = read(payload)?;
                let connection = self.resolve_connection(payload.connection, values).await?;
                let request = ports::FindRequest {
                    id: payload.id,
                    database: payload.database,
                    collection: payload.collection,
                    filter: object(payload.filter),
                    projection: object(payload.projection),
                    sort: object(payload.sort),
                    collation: object(payload.collation),
                    hint: payload.hint,
                    skip: payload.skip,
                    limit: payload.limit.filter(|limit| *limit > 0),
                    page_size: payload.page_size.unwrap_or(DATABASE_PAGE),
                };
                answer(database.find(connection, request).await?)
            }
            Operation::MongoMore => {
                let payload: payloads::MongoMorePayload = read(payload)?;
                answer(
                    database
                        .more(
                            &payload.cursor,
                            &payload.id,
                            payload.page_size.unwrap_or(DATABASE_PAGE),
                        )
                        .await?,
                )
            }
            Operation::MongoCount => {
                let payload: payloads::MongoCountPayload = read(payload)?;
                let connection = self.resolve_connection(payload.connection, values).await?;
                let request = ports::CountRequest {
                    id: payload.id,
                    database: payload.database,
                    collection: payload.collection,
                    filter: object(payload.filter),
                    collation: object(payload.collation),
                    hint: payload.hint,
                    skip: payload.skip,
                    limit: payload.limit.filter(|limit| *limit > 0),
                };
                Ok(serde_json::json!({ "count": database.count(connection, request).await? }))
            }
            Operation::MongoCancel => {
                let payload: payloads::IdPayload = read(payload)?;
                Ok(serde_json::json!({ "cancelled": database.cancel(&payload.id).await? }))
            }
            Operation::MongoClose => {
                let payload: payloads::MongoClosePayload = read(payload)?;
                database.close(&payload.cursor).await?;
                Ok(serde_json::json!({ "closed": true }))
            }
            _ => Err(Error::Validation("Unknown database operation".into())),
        }
    }

    /// A connection with its vault references resolved. The values go to `values`, so they
    /// never leave in an error.
    async fn resolve_connection(
        &self,
        connection: payloads::MongoConnection,
        values: &mut Vec<(String, String)>,
    ) -> Result<DatabaseConnection> {
        let names = vault_references(
            &serde_json::to_value(&connection)
                .map_err(|error| Error::Infrastructure(error.to_string()))?,
        );
        for name in &names {
            values.push((name.clone(), self.secrets.resolve(name).await?));
        }
        let secret_hosts = if names.is_empty() {
            Vec::new()
        } else {
            self.secrets
                .secrets()
                .await?
                .into_iter()
                .filter(|secret| names.contains(&secret.name) && !secret.allowed_hosts.is_empty())
                .map(|secret| {
                    let hosts = AllowedHosts::stored(&secret.allowed_hosts);
                    (secret.name, hosts)
                })
                .collect()
        };
        let field = |text: Option<String>| text.map(|text| replace_vault(&text, values, false));
        Ok(DatabaseConnection {
            uri: replace_vault(&connection.uri, values, true),
            password: field(connection.password),
            ca_pem: field(connection.ca_pem),
            cert_pem: field(connection.cert_pem),
            key_pem: field(connection.key_pem),
            secret_hosts,
        })
    }

    pub async fn git(&self, operation: GitOperation, payload: Value) -> Result<Value> {
        let payload = match payload {
            Value::Null => Value::Object(Map::new()),
            payload => payloads::validate_git(operation, payload)?,
        };
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
        connections: Mutex<Vec<DatabaseConnection>>,
        finds: Mutex<Vec<ports::FindRequest>>,
        documents: Mutex<Vec<Document>>,
        writes: Mutex<Vec<(ports::WriteTarget, ports::DocumentWrite)>>,
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
    #[async_trait]
    impl DocumentDatabase for Fake {
        async fn test(&self, connection: DatabaseConnection) -> Result<ports::ConnectionReport> {
            let failing = connection.uri.contains("fail");
            let password = connection.password.clone().unwrap_or_default();
            self.connections.lock().unwrap().push(connection);
            if failing {
                // As a driver could: the credentials in its message.
                return Err(Error::Validation(format!(
                    "Authentication failed for password {password} ({})",
                    uri_encode(&password)
                )));
            }
            Ok(ports::ConnectionReport {
                server_version: "8.0.4".into(),
                topology: "standalone".into(),
                replica_set: None,
                flavor: None,
                hosts: vec![],
                ping_ms: 1,
                direct: false,
                tls: false,
                auth_mechanism: None,
            })
        }
        async fn databases(
            &self,
            connection: DatabaseConnection,
        ) -> Result<Vec<ports::DatabaseSummary>> {
            self.connections.lock().unwrap().push(connection);
            Ok(vec![ports::DatabaseSummary {
                name: "shop".into(),
                size_on_disk: Some(4096),
                empty: false,
            }])
        }
        async fn collections(
            &self,
            _: DatabaseConnection,
            database: &str,
        ) -> Result<Vec<ports::CollectionSummary>> {
            Ok(vec![ports::CollectionSummary {
                name: format!("{database}-orders"),
                kind: "collection".into(),
                gridfs: None,
                view_on: None,
                capped: false,
            }])
        }
        async fn stats(
            &self,
            _: DatabaseConnection,
            _: &str,
            _: &str,
        ) -> Result<ports::CollectionStats> {
            Err(Error::NotFound)
        }
        async fn find(
            &self,
            connection: DatabaseConnection,
            request: ports::FindRequest,
        ) -> Result<ports::DocumentPage> {
            let password = connection.password.clone().unwrap_or_default();
            self.finds.lock().unwrap().push(request);
            if connection.uri.contains("fail") {
                return Err(Error::Validation(format!("Query failed for {password}")));
            }
            Ok(ports::DocumentPage {
                documents: vec![json!({"_id": {"$oid": "65a1b2c3d4e5f6a7b8c9d0e1"}})],
                cursor: Some("c1".into()),
                truncated: false,
                elapsed_ms: 2,
            })
        }
        async fn more(&self, cursor: &str, _: &str, _: u64) -> Result<ports::DocumentPage> {
            Err(Error::Validation(format!("Cursor {cursor} closed")))
        }
        async fn count(&self, _: DatabaseConnection, request: ports::CountRequest) -> Result<u64> {
            Ok(request.limit.unwrap_or(7))
        }
        async fn cancel(&self, id: &str) -> Result<bool> {
            Ok(id == "running")
        }
        async fn close(&self, _: &str) -> Result<()> {
            Ok(())
        }
        async fn write(
            &self,
            connection: DatabaseConnection,
            target: ports::WriteTarget,
            write: ports::DocumentWrite,
        ) -> Result<ports::WriteResult> {
            self.connections.lock().unwrap().push(connection);
            self.writes.lock().unwrap().push((target, write.clone()));
            let before = json!({"_id": 1, "n": {"$numberInt": "1"}});
            let after = json!({"_id": 1, "n": {"$numberInt": "2"}});
            Ok(match write {
                ports::DocumentWrite::Restore { changes } => ports::WriteResult {
                    matched: changes.len() as u64,
                    modified: changes.len() as u64,
                    ..Default::default()
                },
                _ => ports::WriteResult {
                    matched: 1,
                    modified: 1,
                    changes: vec![ports::DocumentChange {
                        before: Some(before),
                        after: Some(after),
                    }],
                    ..Default::default()
                },
            })
        }
        async fn change(
            &self,
            connection: DatabaseConnection,
            _: ports::CollectionChange,
        ) -> Result<()> {
            self.connections.lock().unwrap().push(connection);
            Ok(())
        }
    }
    fn application() -> (Application, Arc<Fake>) {
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
    async fn database_connections_get_their_secrets_but_never_return_them() {
        let (application, fake) = application();
        let missing = application
            .execute(
                Operation::MongoTest,
                json!({"connection": {"uri": "mongodb://db.test", "password": "{{vault:deleted}}"}}),
            )
            .await;
        assert!(
            missing
                .unwrap_err()
                .to_string()
                .contains("Secret not found")
        );
        let report = application
            .execute(
                Operation::MongoTest,
                json!({"connection": {
                    "uri": "mongodb://{{vault:user}}@db.test/?authSource=admin",
                    "password": "{{vault:pass}}",
                    "keyPem": "{{ vault:key }}",
                }}),
            )
            .await
            .unwrap();
        assert_eq!(report["serverVersion"], "8.0.4");
        assert!(report.get("replicaSet").is_none());
        let connection = fake.connections.lock().unwrap()[0].clone();
        // The fake vault answers `secret-of-<name>`.
        assert_eq!(
            connection.uri,
            "mongodb://secret-of-user@db.test/?authSource=admin"
        );
        assert_eq!(connection.password.as_deref(), Some("secret-of-pass"));
        assert_eq!(connection.key_pem.as_deref(), Some("secret-of-key"));
        assert!(!format!("{connection:?}").contains("secret-of-pass"));
        assert!(!format!("{connection:?}").contains("secret-of-key"));

        let error = application
            .execute(
                Operation::MongoTest,
                json!({"connection": {"uri": "mongodb://fail@db.test", "password": "{{vault:p@ss}}"}}),
            )
            .await
            .unwrap_err()
            .to_string();
        assert_eq!(
            error,
            "Authentication failed for password [redacted] ([redacted])"
        );
    }

    #[tokio::test]
    async fn queries_reach_the_database_with_their_documents_and_defaults() {
        let (application, fake) = application();
        let connection = json!({"uri": "mongodb://ana@db.test", "password": "{{vault:pass}}"});
        let databases = application
            .execute(
                Operation::MongoDatabases,
                json!({"connection": connection.clone()}),
            )
            .await
            .unwrap();
        assert_eq!(
            databases,
            json!({"databases": [{"name": "shop", "sizeOnDisk": 4096, "empty": false}]})
        );
        let collections = application
            .execute(
                Operation::MongoCollections,
                json!({"connection": connection.clone(), "database": "shop"}),
            )
            .await
            .unwrap();
        assert_eq!(collections["collections"][0]["name"], "shop-orders");
        let page = application
            .execute(
                Operation::MongoFind,
                json!({"connection": connection.clone(), "id": "q1", "database": "shop",
                    "collection": "orders", "filter": {"status": "A"}, "limit": 0}),
            )
            .await
            .unwrap();
        assert_eq!(page["cursor"], "c1");
        assert_eq!(
            page["documents"][0]["_id"]["$oid"],
            "65a1b2c3d4e5f6a7b8c9d0e1"
        );
        let request = fake.finds.lock().unwrap()[0].clone();
        assert_eq!(request.filter, Some(json!({"status": "A"})));
        assert_eq!(request.limit, None, "a limit of 0 means every document");
        assert_eq!(request.page_size, DATABASE_PAGE);
        let count = application
            .execute(
                Operation::MongoCount,
                json!({"connection": connection.clone(), "id": "q2", "database": "shop",
                    "collection": "orders", "limit": 3}),
            )
            .await
            .unwrap();
        assert_eq!(count, json!({"count": 3}));
        let cancelled = application
            .execute(Operation::MongoCancel, json!({"id": "running"}))
            .await
            .unwrap();
        assert_eq!(cancelled, json!({"cancelled": true}));
        let error = application
            .execute(Operation::MongoMore, json!({"cursor": "gone", "id": "q3"}))
            .await
            .unwrap_err();
        assert_eq!(error.to_string(), "Cursor gone closed");
        // The vault values of the connection never come back in an error.
        let error = application
            .execute(
                Operation::MongoFind,
                json!({"connection": {"uri": "mongodb://fail@db.test", "password": "{{vault:pass}}"},
                    "id": "q4", "database": "shop", "collection": "orders"}),
            )
            .await
            .unwrap_err();
        assert_eq!(error.to_string(), "Query failed for [redacted]");
    }

    #[tokio::test]
    async fn writes_are_refused_on_read_only_and_other_connections_and_recorded() {
        let (application, fake) = application();
        let saved = |id: &str, value: Value| {
            fake.documents.lock().unwrap().push(Document {
                id: DocumentId::parse(id).unwrap(),
                workspace_id: WorkspaceId::parse("local").unwrap(),
                kind: DocumentKind::Connection,
                name: id.into(),
                revision: 1,
                updated_at: 0,
                value,
            })
        };
        saved("ro", json!({"uri": "mongodb://{{host}}", "readOnly": true}));
        saved(
            "rw",
            json!({"uri": "mongodb://{{host}}", "password": "{{vault:p}}"}),
        );
        let write = |operation: Operation, extra: Value| {
            let mut payload = json!({
                "workspace": "local", "connectionId": "rw", "database": "shop",
                "collection": "orders",
                "connection": {"uri": "mongodb://db.test", "password": "{{vault:p}}"},
            });
            for (key, value) in extra.as_object().unwrap() {
                if value.is_null() {
                    payload.as_object_mut().unwrap().remove(key);
                } else {
                    payload[key] = value.clone();
                }
            }
            application.execute(operation, payload)
        };
        let error = |result: Result<Value>| result.unwrap_err().to_string();
        assert_eq!(
            error(
                write(
                    Operation::MongoInsert,
                    json!({"connectionId": "ro", "connection": {"uri": "mongodb://db.test"},
                        "documents": [{}]})
                )
                .await
            ),
            "The connection ro is read-only: Nexo refuses its writes"
        );
        for (refused, extra) in [
            (Operation::MongoCollectionCreate, json!({})),
            (Operation::MongoCollectionRename, json!({"to": "x"})),
            (Operation::MongoCollectionDrop, json!({"confirm": "orders"})),
        ] {
            let mut payload =
                json!({"connectionId": "ro", "connection": {"uri": "mongodb://db.test"}});
            payload
                .as_object_mut()
                .unwrap()
                .extend(extra.as_object().unwrap().clone());
            let result = write(refused, payload).await;
            assert!(error(result).contains("read-only"), "{refused}");
        }
        assert!(
            error(
                write(
                    Operation::MongoInsert,
                    json!({"connection": {"uri": "mongodb+srv://db.test",
                        "password": "{{vault:p}}"}, "documents": [{}]})
                )
                .await
            )
            .contains("not the saved one")
        );
        assert!(
            error(
                write(
                    Operation::MongoUpdate,
                    json!({"filter": {}, "update": {"$set": {"a": 1}}, "many": true})
                )
                .await
            )
            .starts_with("Count the documents first")
        );
        assert_eq!(
            error(
                write(
                    Operation::MongoDelete,
                    json!({"filter": {}, "many": true, "expected": 3})
                )
                .await
            ),
            "Type the name of the collection to confirm: orders"
        );
        assert!(
            error(
                write(
                    Operation::MongoDatabaseDrop,
                    json!({"confirm": "orders", "collection": null})
                )
                .await
            )
            .contains("database to confirm: shop")
        );
        assert!(
            application
                .execute(
                    Operation::MongoInsert,
                    json!({"connectionId": "rw", "database": "d", "collection": "c",
                        "connection": {"uri": "mongodb://db.test"}, "documents": []}),
                )
                .await
                .unwrap_err()
                .to_string()
                .contains("Choose a workspace")
        );
        assert!(
            fake.writes.lock().unwrap().is_empty(),
            "nothing refused was written"
        );

        // A write is recorded with its documents, and undone from the record.
        let done = write(
            Operation::MongoUpdate,
            json!({"filter": {"_id": 1}, "update": {"$set": {"n": 2}}}),
        )
        .await
        .unwrap();
        assert_eq!(
            (done["matched"].clone(), done["modified"].clone()),
            (json!(1), json!(1))
        );
        let change = done["change"].as_str().unwrap().to_string();
        let recorded = fake
            .documents
            .lock()
            .unwrap()
            .iter()
            .find(|d| d.id.as_str() == change)
            .cloned()
            .unwrap();
        assert_eq!(recorded.kind, DocumentKind::DatabaseChange);
        assert_eq!(recorded.value["operation"], "mongo.update");
        assert_eq!(
            recorded.value["changes"][0]["before"]["n"]["$numberInt"],
            "1"
        );
        assert!(!recorded.value.to_string().contains("secret-of-p"));
        assert_eq!(
            fake.connections
                .lock()
                .unwrap()
                .last()
                .unwrap()
                .password
                .as_deref(),
            Some("secret-of-p")
        );
        let undone = write(
            Operation::MongoUndo,
            json!({"change": change, "database": null, "collection": null}),
        )
        .await
        .unwrap();
        assert_eq!(undone["matched"], 1);
        let (_, last) = fake.writes.lock().unwrap().last().cloned().unwrap();
        assert!(
            matches!(last, ports::DocumentWrite::Restore { ref changes } if changes.len() == 1)
        );
        assert!(
            error(
                write(
                    Operation::MongoUndo,
                    json!({"change": "rw", "database": null, "collection": null})
                )
                .await
            )
            .contains("not one of this connection")
        );
    }

    #[test]
    fn vault_values_are_encoded_inside_uris() {
        let values = vec![("u".to_string(), "ana@corp:1/x".to_string())];
        assert_eq!(
            replace_vault("mongodb://{{vault:u}}@h/{{db}}", &values, true),
            "mongodb://ana%40corp%3A1%2Fx@h/{{db}}"
        );
        assert_eq!(
            replace_vault("{{vault:u}} {{x", &values, false),
            "ana@corp:1/x {{x"
        );
    }

    #[tokio::test]
    async fn datasets_are_scoped_to_an_existing_workspace() {
        let (application, fake) = application();
        application
            .execute(
                Operation::DatasetQuery,
                json!({"workspace": "local", "id": "d", "sql": "SELECT 1"}),
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
                    json!({"workspace": "missing", "id": "d", "sql": "SELECT 1"})
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
