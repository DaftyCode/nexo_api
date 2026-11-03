//! Use cases depend only on domain types and outbound ports.
pub mod ports;
use nexo_domain::{Actor, Document, Error, Result, validate_operation};
use ports::{ExecutionGateway, IdentityProvider, SecretVault, VersionControl, WorkspaceRepository};
use serde_json::Value;
use std::sync::Arc;

pub struct Application {
    pub workspaces: Arc<dyn WorkspaceRepository>,
    pub identity: Arc<dyn IdentityProvider>,
    executor: Arc<dyn ExecutionGateway>,
    pub secrets: Arc<dyn SecretVault>,
    git: Arc<dyn VersionControl>,
}
impl Application {
    pub fn new(
        workspaces: Arc<dyn WorkspaceRepository>,
        identity: Arc<dyn IdentityProvider>,
        executor: Arc<dyn ExecutionGateway>,
        secrets: Arc<dyn SecretVault>,
        git: Arc<dyn VersionControl>,
    ) -> Self {
        Self {
            workspaces,
            identity,
            executor,
            secrets,
            git,
        }
    }
    pub async fn save_document(&self, actor: &Actor, document: Document) -> Result<Document> {
        document.validate()?;
        self.workspaces.save(actor, document).await
    }
    pub async fn execute(
        &self,
        actor: &Actor,
        operation: &str,
        mut payload: Value,
    ) -> Result<Value> {
        validate_operation(operation)?;
        if ["request", "run", "performance"].contains(&operation)
            && payload.get("secretNames").is_none()
        {
            let text = payload.to_string();
            let mut names = Vec::<Value>::new();
            let mut rest = text.as_str();
            while let Some(index) = rest.find("{{vault:") {
                rest = &rest[index + 8..];
                if let Some(end) = rest.find("}}") {
                    let name = &rest[..end];
                    if !name.is_empty()
                        && name.len() <= 200
                        && !names.iter().any(|v| v.as_str() == Some(name))
                    {
                        names.push(Value::String(name.into()));
                    }
                    rest = &rest[end + 2..];
                } else {
                    break;
                }
            }
            if !names.is_empty() {
                payload
                    .as_object_mut()
                    .ok_or_else(|| Error::Validation("Expected object".into()))?
                    .insert("secretNames".into(), Value::Array(names));
            }
        }
        // Resolve references only within this actor's vault, immediately before execution.
        if let Some(names) = payload
            .get("secretNames")
            .and_then(Value::as_array)
            .cloned()
        {
            let mut secrets = serde_json::Map::new();
            for name in names.iter().filter_map(Value::as_str) {
                secrets.insert(
                    name.into(),
                    Value::String(self.secrets.resolve(actor, name).await?),
                );
            }
            payload
                .as_object_mut()
                .ok_or_else(|| Error::Validation("Expected an object".into()))?
                .insert("resolvedSecrets".into(), Value::Object(secrets));
        }
        self.executor.execute(actor, operation, payload).await
    }
    pub async fn git(&self, actor: &Actor, operation: &str, payload: Value) -> Result<Value> {
        if ![
            "init", "status", "diff", "log", "branches", "checkout", "branch", "commit", "stash",
            "export",
        ]
        .contains(&operation)
        {
            return Err(Error::Validation("Unsupported Git operation".into()));
        }
        self.workspaces
            .documents(
                actor,
                payload["workspace"].as_str().unwrap_or("local"),
                None,
            )
            .await?;
        self.git.execute(actor, operation, payload).await
    }
}
