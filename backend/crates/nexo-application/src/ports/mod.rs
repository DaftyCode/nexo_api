//! Driven ports. Implementations belong to infrastructure, never the domain.
use crate::operations::{GitOperation, Operation};
use async_trait::async_trait;
use nexo_domain::{
    Document, DocumentId, DocumentKind, DocumentSummary, Result, Revision, SecretSummary,
    Workspace, WorkspaceId, hosts::AllowedHosts,
};
use serde_json::Value;

mod clock;
mod database;
mod datasource;
mod modules;
mod queries;
mod routes;
mod scripts;
mod watch;
mod writes;

pub use clock::*;
pub use database::*;
pub use datasource::*;
pub use modules::*;
pub use queries::*;
pub use routes::*;
pub use scripts::*;
pub use watch::*;
pub use writes::*;

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
    /// Keeps the newest documents of a kind that `retention` allows and deletes the rest;
    /// returns how many.
    async fn prune(
        &self,
        workspace: &WorkspaceId,
        kind: DocumentKind,
        retention: Retention,
    ) -> Result<usize>;
}
/// How much of a kind of document a workspace keeps: the newest `entries`, and of those
/// only the newest that fit together in `bytes`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Retention {
    pub entries: usize,
    pub bytes: Option<usize>,
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
/// The egress policy, for tools that connect on their own (Git, MongoDB, database drivers)
/// instead of through the engine's transport, and the routes they connect through.
#[async_trait]
pub trait NetworkPolicy: Send + Sync {
    /// Refuses a destination the egress policy blocks, after resolving it.
    async fn check_destination(&self, host: &str, port: u16) -> Result<()>;
    /// The addresses of a destination, every one allowed by the egress policy, for adapters
    /// that then connect to the address and not to the name (database drivers): what was
    /// checked is what is connected to.
    async fn resolve_destination(&self, host: &str, port: u16)
    -> Result<Vec<std::net::SocketAddr>>;
    /// Whether the policy refuses some destinations (`deny-private`). Adapters that cannot
    /// check every address their library connects to are stricter then.
    fn restrictive(&self) -> bool {
        false
    }
    /// The SOCKS5 proxy through which a connection with this route reaches its servers: the
    /// route's own proxy, checked against the egress policy, or the loopback end of the
    /// tunnel of its SSH profile, opened (and the server's key checked) when needed. `None`
    /// when it goes directly. Database protocols cannot go through an HTTP proxy.
    async fn socks_proxy(&self, route: &ConnectionRoute) -> Result<Option<SocksProxy>> {
        unrouted(route)
    }
    /// Refuses a destination reached through a proxy or a tunnel: one the policy allows by
    /// name passes; any other is resolved here and checked, so a name only the far side
    /// knows can be reached only when the policy allows every destination or that name.
    async fn check_routed_destination(&self, host: &str, port: u16) -> Result<()> {
        self.check_destination(host, port).await
    }
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
