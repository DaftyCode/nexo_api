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

/// A database of a deployment.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseSummary {
    pub name: String,
    /// Bytes on disk, when the server says.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub size_on_disk: Option<i64>,
    pub empty: bool,
}

/// A collection, view or time series collection of a database.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CollectionSummary {
    pub name: String,
    /// `collection`, `view` or `timeseries`.
    pub kind: String,
    /// The GridFS bucket it belongs to (`fs` for `fs.files` and `fs.chunks`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub gridfs: Option<String>,
    /// A view's source collection.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub view_on: Option<String>,
    pub capped: bool,
}

/// An index of a collection.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexSummary {
    pub name: String,
    /// The index keys, in canonical Extended JSON.
    pub keys: Value,
    pub unique: bool,
}

/// Size and indexes of a collection.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CollectionStats {
    pub count: i64,
    /// Bytes of the documents, uncompressed.
    pub size: i64,
    pub storage_size: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub average_document_size: Option<i64>,
    pub total_index_size: i64,
    pub indexes: Vec<IndexSummary>,
    pub capped: bool,
}

/// A `find` on a collection. Filter, projection, sort, collation and hint are Extended JSON
/// (canonical or relaxed); the interface converts the shell syntax before sending it.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct FindRequest {
    /// Chosen by the client, to cancel the query while it runs.
    pub id: String,
    pub database: String,
    pub collection: String,
    pub filter: Option<Value>,
    pub projection: Option<Value>,
    pub sort: Option<Value>,
    pub collation: Option<Value>,
    /// An index name or its keys.
    pub hint: Option<Value>,
    pub skip: Option<u64>,
    /// Documents in total, as the query's `limit`; none for all of them.
    pub limit: Option<u64>,
    /// Documents in each page.
    pub page_size: u64,
}

/// A page of documents.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentPage {
    /// Each document in canonical Extended JSON, so its BSON types are kept.
    pub documents: Vec<Value>,
    /// Reads the next page while the server keeps the cursor open.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cursor: Option<String>,
    /// The page stopped early because it reached the size the interface receives at once.
    pub truncated: bool,
    pub elapsed_ms: u64,
}

/// A `countDocuments` with a query's filter.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct CountRequest {
    pub id: String,
    pub database: String,
    pub collection: String,
    pub filter: Option<Value>,
    pub collation: Option<Value>,
    pub hint: Option<Value>,
    pub skip: Option<u64>,
    pub limit: Option<u64>,
}

/// Where a write goes, and the write concern of this operation when it is not the
/// connection's (`{w, j, wtimeout}`).
#[derive(Debug, Clone, Default, PartialEq)]
pub struct WriteTarget {
    pub database: String,
    pub collection: String,
    pub write_concern: Option<Value>,
}

/// A write on the documents of a collection. Documents and filters are Extended JSON.
#[derive(Debug, Clone, PartialEq)]
pub enum DocumentWrite {
    Insert {
        documents: Vec<Value>,
    },
    /// `update` is an update document or an aggregation pipeline.
    Update {
        filter: Value,
        update: Value,
        many: bool,
        /// With `many`, how many documents the person was told would change: if the filter
        /// now matches another number, nothing is written.
        expected: Option<u64>,
    },
    Replace {
        filter: Value,
        replacement: Value,
    },
    Delete {
        filter: Value,
        many: bool,
        expected: Option<u64>,
    },
    /// Undoes recorded changes: each document goes back to `before`, if it is still as
    /// `after` left it.
    Restore {
        changes: Vec<DocumentChange>,
    },
}

/// A document before and after a write; `None` where it did not exist.
#[derive(Debug, Clone, PartialEq, Serialize, serde::Deserialize)]
pub struct DocumentChange {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub before: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub after: Option<Value>,
}

/// What a write did.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WriteResult {
    pub matched: u64,
    pub modified: u64,
    pub deleted: u64,
    /// `_id` of each inserted (or upserted) document, in Extended JSON.
    pub inserted: Vec<Value>,
    /// Each document the write changed, to undo it. Writes of many documents do not list
    /// them.
    #[serde(skip)]
    pub changes: Vec<DocumentChange>,
}

/// Changes to databases and collections.
#[derive(Debug, Clone, PartialEq)]
pub enum CollectionChange {
    /// `options`: capped (`size`, `max`), `timeseries`, `validator` and its level and action,
    /// `collation`, `expireAfterSeconds`.
    Create {
        database: String,
        collection: String,
        options: Option<Value>,
    },
    Rename {
        database: String,
        collection: String,
        to: String,
    },
    Drop {
        database: String,
        collection: String,
    },
    DropDatabase {
        database: String,
    },
}

/// An index with how much room it takes and how often queries use it.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexDetail {
    pub name: String,
    /// The index as `listIndexes` gives it (keys and options), in canonical Extended JSON.
    pub spec: Value,
    /// Bytes on disk, added up over the shards.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub size: Option<i64>,
    /// Operations that used it since `since` (`$indexStats`), added up over the servers.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub accesses: Option<i64>,
    /// When the server started counting, in ISO 8601.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub since: Option<String>,
}

/// Changes to the indexes of a collection.
#[derive(Debug, Clone, PartialEq)]
pub enum IndexChange {
    /// `keys` and `options` are Extended JSON documents; options are those of `createIndexes`.
    Create {
        database: String,
        collection: String,
        keys: Value,
        options: Option<Value>,
    },
    /// Hides an index from the query planner, or shows it again, without dropping it.
    Hide {
        database: String,
        collection: String,
        name: String,
        hidden: bool,
    },
    Drop {
        database: String,
        collection: String,
        name: String,
    },
}

/// What an explain describes: a `find` or an aggregation pipeline.
#[derive(Debug, Clone, PartialEq)]
pub enum Explained {
    Find(Box<FindRequest>),
    Aggregate {
        pipeline: Vec<Value>,
        collation: Option<Value>,
        hint: Option<Value>,
    },
}

/// An explain of a query. With `execution_stats` the server runs the query to measure it
/// (`executionStats`); without it, it only plans it (`queryPlanner`).
#[derive(Debug, Clone, PartialEq)]
pub struct ExplainRequest {
    /// Chosen by the client, to cancel it while it runs.
    pub id: String,
    pub database: String,
    pub collection: String,
    pub explained: Explained,
    pub execution_stats: bool,
}

/// The profiler of a database: level 0 (off), 1 (operations slower than `slowms`) or 2 (all).
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileStatus {
    pub level: i64,
    pub slowms: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sample_rate: Option<f64>,
}

/// An operation the profiler recorded.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileEntry {
    /// `query`, `command`, `getmore`, `insert`, `update`, `remove`…
    pub op: String,
    /// `database.collection`.
    pub ns: String,
    pub millis: i64,
    /// When it ran, in ISO 8601.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ts: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub plan_summary: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub docs_examined: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub keys_examined: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub returned: Option<i64>,
    /// The command as the server received it, in canonical Extended JSON; for a `getMore`,
    /// the command that opened its cursor. Large commands are left out.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub command: Option<Value>,
}

/// A document database (MongoDB and compatible servers). Connections are opened once and
/// kept for a while; every server is checked against the egress policy when one opens.
#[async_trait]
pub trait DocumentDatabase: Send + Sync {
    /// Connects, checks every server against the egress policy and the secrets' allowed
    /// domains, pings and describes the deployment.
    async fn test(&self, connection: DatabaseConnection) -> Result<ConnectionReport>;
    async fn databases(&self, connection: DatabaseConnection) -> Result<Vec<DatabaseSummary>>;
    async fn collections(
        &self,
        connection: DatabaseConnection,
        database: &str,
    ) -> Result<Vec<CollectionSummary>>;
    async fn stats(
        &self,
        connection: DatabaseConnection,
        database: &str,
        collection: &str,
    ) -> Result<CollectionStats>;
    /// The first page of a query.
    async fn find(
        &self,
        connection: DatabaseConnection,
        request: FindRequest,
    ) -> Result<DocumentPage>;
    /// The next page of an open cursor. `id` cancels it while it runs.
    async fn more(&self, cursor: &str, id: &str, page_size: u64) -> Result<DocumentPage>;
    async fn count(&self, connection: DatabaseConnection, request: CountRequest) -> Result<u64>;
    /// Stops a running query and whatever it started on the server. Whether one was running.
    async fn cancel(&self, id: &str) -> Result<bool>;
    /// Closes a cursor the interface no longer reads.
    async fn close(&self, cursor: &str) -> Result<()>;
    /// Writes documents. The application has already checked that the connection may write.
    async fn write(
        &self,
        connection: DatabaseConnection,
        target: WriteTarget,
        write: DocumentWrite,
    ) -> Result<WriteResult>;
    /// Creates, renames or drops a collection, or drops a database.
    async fn change(&self, connection: DatabaseConnection, change: CollectionChange) -> Result<()>;
    /// The indexes of a collection with their size and use.
    async fn indexes(
        &self,
        connection: DatabaseConnection,
        database: &str,
        collection: &str,
    ) -> Result<Vec<IndexDetail>>;
    /// Creates, hides, shows or drops an index. The application has already checked that
    /// the connection may write.
    async fn index(&self, connection: DatabaseConnection, change: IndexChange) -> Result<()>;
    /// How the server runs a query, in relaxed Extended JSON. `id` cancels it while it runs.
    async fn explain(
        &self,
        connection: DatabaseConnection,
        request: ExplainRequest,
    ) -> Result<Value>;
    /// The profiler of a database, after changing it to `set` when given. Changing it is a
    /// write the application has already allowed.
    async fn profile(
        &self,
        connection: DatabaseConnection,
        database: &str,
        set: Option<(i64, Option<i64>)>,
    ) -> Result<ProfileStatus>;
    /// The slowest operations the profiler recorded in a database, or in one of its
    /// collections, slowest first.
    async fn profiled(
        &self,
        connection: DatabaseConnection,
        database: &str,
        collection: Option<&str>,
        limit: u64,
    ) -> Result<Vec<ProfileEntry>>;
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
