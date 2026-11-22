//! What describes a deployment, its databases and collections.
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// A server of a connection and whether Nexo may reach it.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
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

/// What a connection found when it opened.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
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
    /// Nexo connected only to the first server: a server the replica set announces may not
    /// be reached.
    pub direct: bool,
    pub tls: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub auth_mechanism: Option<String>,
}

/// A database of a deployment.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct DatabaseSummary {
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub size_on_disk: Option<i64>,
    pub empty: bool,
}

/// A collection, view or time series collection of a database.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct CollectionSummary {
    pub name: String,
    /// `collection`, `view` or `timeseries`.
    pub kind: String,
    /// The GridFS bucket it belongs to (`fs` for `fs.files` and `fs.chunks`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub gridfs: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub view_on: Option<String>,
    pub capped: bool,
}

/// An index of a collection.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct IndexSummary {
    pub name: String,
    /// The index keys, in canonical Extended JSON.
    pub keys: Value,
    pub unique: bool,
}

/// Size and indexes of a collection.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct CollectionStats {
    pub count: i64,
    pub size: i64,
    pub storage_size: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub average_document_size: Option<i64>,
    pub total_index_size: i64,
    pub indexes: Vec<IndexSummary>,
    pub capped: bool,
}
