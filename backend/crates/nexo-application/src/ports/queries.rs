//! Queries, explain and the profiler of a document database.
use serde::Serialize;
use serde_json::Value;

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
