//! Driven ports. Implementations belong to infrastructure, never the domain.
use crate::operations::{GitOperation, Operation};
use async_trait::async_trait;
use nexo_domain::{
    Document, DocumentId, DocumentKind, DocumentSummary, Result, Revision, SecretSummary,
    Workspace, WorkspaceId, hosts::AllowedHosts,
};
use serde::Serialize;
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
    /// Whether the policy refuses some destinations (`deny-private`). Adapters that cannot
    /// check every address their library connects to are stricter then.
    fn restrictive(&self) -> bool {
        false
    }
}

/// A database connection as an adapter receives it: vault references already resolved.
#[derive(Clone, Default)]
pub struct DatabaseConnection {
    /// The URI without a password; environment variables are already replaced.
    pub uri: String,
    pub password: Option<String>,
    /// Certificate authorities trusted besides the system's, in PEM.
    pub ca_pem: Option<String>,
    /// The client certificate and its key, in PEM, for TLS client authentication (X.509).
    pub cert_pem: Option<String>,
    pub key_pem: Option<String>,
    /// Vault secrets of the connection that may only reach some hosts, by name.
    pub secret_hosts: Vec<(String, AllowedHosts)>,
}
impl std::fmt::Debug for DatabaseConnection {
    /// Never shows the password or the key, should a connection end up in a log.
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("DatabaseConnection")
            .field("uri", &self.uri)
            .field("password", &self.password.as_ref().map(|_| "[redacted]"))
            .field("key_pem", &self.key_pem.as_ref().map(|_| "[redacted]"))
            .finish_non_exhaustive()
    }
}

/// A server of a connection and whether Nexo may reach it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseHost {
    /// `host:port`.
    pub address: String,
    /// `primary`, `secondary`, `arbiter`, `passive`, `mongos` or `seed` (not contacted).
    pub role: String,
    pub allowed: bool,
    /// Why it is not allowed (egress policy or a secret's allowed domains).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

/// What "Test connection" found.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionReport {
    pub server_version: String,
    /// `standalone`, `replicaSet`, `sharded` or `loadBalanced`.
    pub topology: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub replica_set: Option<String>,
    /// A compatible server that is not MongoDB, such as FerretDB or Amazon DocumentDB.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub flavor: Option<String>,
    pub hosts: Vec<DatabaseHost>,
    /// Round trip of a `ping`, in milliseconds.
    pub ping_ms: u64,
    /// Nexo connected only to the first server: under a restrictive egress policy, when a
    /// server the replica set announces may not be reached.
    pub direct: bool,
    pub tls: bool,
    /// The authentication mechanism used, or none.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub auth_mechanism: Option<String>,
}

/// A document database (MongoDB and compatible servers).
#[async_trait]
pub trait DocumentDatabase: Send + Sync {
    /// Connects, checks every server against the egress policy and the secrets' allowed
    /// domains, pings and describes the deployment.
    async fn test(&self, connection: DatabaseConnection) -> Result<ConnectionReport>;
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
