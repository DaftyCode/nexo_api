//! Engine and Git operations: the payload is checked, scoped to its workspace and given the
//! vault values it references, immediately before it runs.
use crate::{
    Application,
    operations::{GitOperation, Operation},
    payloads,
    vault::{is_oauth2_token, vault_references},
};
use nexo_domain::{Error, Result, WorkspaceId};
use serde_json::{Map, Value};

/// Payload fields that only the backend may set; values sent by clients are discarded.
const INTERNAL_FIELDS: [&str; 6] = [
    "secretNames",
    "resolvedSecrets",
    "secretHosts",
    "resolvedOAuth2",
    "scope",
    "egressLoopbackPorts",
];

impl Application {
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
        if operation.is_module() {
            return self.module(operation, &payload).await;
        }
        if operation.is_datasource() {
            return self.datasource(operation, Value::Object(payload)).await;
        }
        if operation.is_database() {
            return self.database(operation, Value::Object(payload)).await;
        }
        // Change streams are sessions of the database, read like the engine's connections.
        if let Some(answer) = self.realtime_watch(operation, &payload).await? {
            return Ok(answer);
        }
        if operation == Operation::RealtimeList {
            let engine = self
                .executor
                .execute(operation, Value::Object(payload))
                .await?;
            return self.realtime_list(engine).await;
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
