//! Driven ports. Implementations belong to infrastructure, never the domain.
use async_trait::async_trait;
use nexo_domain::{Actor, Credentials, Document, Result, Revision, Session, Workspace};
use serde_json::Value;

#[async_trait]
pub trait WorkspaceRepository: Send + Sync {
    async fn workspaces(&self, actor: &Actor) -> Result<Vec<Workspace>>;
    async fn create_workspace(&self, actor: &Actor, name: &str) -> Result<Workspace>;
    async fn members(&self, actor: &Actor, workspace: &str) -> Result<Value>;
    async fn add_member(
        &self,
        actor: &Actor,
        workspace: &str,
        email: &str,
        role: &str,
    ) -> Result<()>;
    async fn documents(
        &self,
        actor: &Actor,
        workspace: &str,
        kind: Option<&str>,
    ) -> Result<Vec<Document>>;
    async fn document(&self, actor: &Actor, id: &str) -> Result<Document>;
    async fn save(&self, actor: &Actor, document: Document) -> Result<Document>;
    async fn delete(&self, actor: &Actor, id: &str, revision: i64) -> Result<()>;
    async fn revisions(&self, actor: &Actor, id: &str) -> Result<Vec<Revision>>;
}
#[async_trait]
pub trait IdentityProvider: Send + Sync {
    async fn has_users(&self) -> Result<bool>;
    async fn register(&self, credentials: Credentials, allow_signup: bool) -> Result<Session>;
    async fn login(&self, credentials: Credentials) -> Result<Session>;
    async fn resolve(&self, token: &str) -> Result<Actor>;
    async fn logout(&self, token: &str) -> Result<()>;
}
#[async_trait]
pub trait ExecutionGateway: Send + Sync {
    async fn execute(&self, actor: &Actor, operation: &str, payload: Value) -> Result<Value>;
}
#[async_trait]
pub trait SecretVault: Send + Sync {
    async fn put(&self, actor: &Actor, name: &str, value: &str) -> Result<()>;
    async fn remove(&self, actor: &Actor, name: &str) -> Result<()>;
    async fn resolve(&self, actor: &Actor, name: &str) -> Result<String>;
}
#[async_trait]
pub trait VersionControl: Send + Sync {
    async fn execute(&self, actor: &Actor, operation: &str, payload: Value) -> Result<Value>;
}
