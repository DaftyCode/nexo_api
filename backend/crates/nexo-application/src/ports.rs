//! Driven ports. Implementations belong to infrastructure, never the domain.
use crate::operations::{GitOperation, Operation};
use async_trait::async_trait;
use nexo_domain::{
    Document, DocumentId, DocumentKind, DocumentSummary, Result, Revision, SecretSummary,
    Workspace, WorkspaceId, hosts::AllowedHosts,
};
use serde_json::Value;

#[async_trait]
pub trait WorkspaceRepository: Send + Sync {
    async fn workspaces(&self) -> Result<Vec<Workspace>>;
    async fn create_workspace(&self, name: &str) -> Result<Workspace>;
    async fn rename_workspace(&self, id: &WorkspaceId, name: &str) -> Result<Workspace>;
    /// Removes a workspace with its documents and their revisions.
    async fn delete_workspace(&self, id: &WorkspaceId) -> Result<()>;
    /// Documents without their values, newest first.
    async fn summaries(
        &self,
        workspace: &WorkspaceId,
        kind: Option<DocumentKind>,
    ) -> Result<Vec<DocumentSummary>>;
    async fn documents(
        &self,
        workspace: &WorkspaceId,
        kind: Option<DocumentKind>,
    ) -> Result<Vec<Document>>;
    async fn document(&self, id: &DocumentId) -> Result<Document>;
    async fn save(&self, document: Document) -> Result<Document>;
    async fn delete(&self, id: &DocumentId, revision: i64) -> Result<()>;
    async fn revisions(&self, id: &DocumentId) -> Result<Vec<Revision>>;
    /// Keeps the newest `keep` documents of a kind and deletes the rest; returns how many.
    async fn prune(
        &self,
        workspace: &WorkspaceId,
        kind: DocumentKind,
        keep: usize,
    ) -> Result<usize>;
}
#[async_trait]
pub trait ExecutionGateway: Send + Sync {
    async fn execute(&self, operation: Operation, payload: Value) -> Result<Value>;
    /// Whether the execution engine is currently able to accept work.
    async fn healthy(&self) -> bool {
        true
    }
}
#[async_trait]
pub trait SecretVault: Send + Sync {
    /// Stores a value, allowed hosts or both; what is not given is kept.
    async fn put(
        &self,
        name: &str,
        value: Option<&str>,
        allowed_hosts: Option<&AllowedHosts>,
    ) -> Result<()>;
    async fn remove(&self, name: &str) -> Result<()>;
    async fn resolve(&self, name: &str) -> Result<String>;
    /// The stored secrets with their allowed hosts, never their values.
    async fn secrets(&self) -> Result<Vec<SecretSummary>>;
}
/// The egress policy, for tools that connect on their own (Git) instead of through the
/// engine's transport.
#[async_trait]
pub trait NetworkPolicy: Send + Sync {
    /// Refuses a destination the egress policy blocks, after resolving it.
    async fn check_destination(&self, host: &str, port: u16) -> Result<()>;
}
#[async_trait]
pub trait VersionControl: Send + Sync {
    async fn execute(
        &self,
        workspace: &WorkspaceId,
        operation: GitOperation,
        payload: Value,
    ) -> Result<Value>;
}
