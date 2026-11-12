//! The document database port and what describes a connection, its databases and
//! collections.
use super::*;
use async_trait::async_trait;
use nexo_domain::Result;
use serde::Serialize;
use serde_json::Value;

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
    /// Writes a batch of an import; refused, like every write, on a read-only connection.
    async fn import(
        &self,
        connection: DatabaseConnection,
        target: WriteTarget,
        batch: ImportBatch,
    ) -> Result<ImportResult>;
}
