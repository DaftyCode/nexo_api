//! Queries, explain and the profiler. Filters, projections, sorts, collations, hints and
//! stages are Extended JSON.
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// A `find` on a collection.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default, deny_unknown_fields)]
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
    /// Documents in total; none for all of them.
    pub limit: Option<u64>,
    /// Documents in each page.
    pub page_size: u64,
}

/// Aggregation stages that write their results to a collection: they run only with an
/// aggregation that writes, never in a preview, an explain or a read.
pub const WRITING_STAGES: [&str; 2] = ["$out", "$merge"];

/// Options of an aggregation.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default, deny_unknown_fields)]
pub struct AggregateOptions {
    pub collation: Option<Value>,
    pub hint: Option<Value>,
    pub allow_disk_use: bool,
    /// How long the server may run it, in milliseconds; the driver's limit when absent.
    pub max_time_ms: Option<u64>,
}

/// An aggregation pipeline that only reads, read a page at a time like a `find`.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default, deny_unknown_fields)]
pub struct AggregateRequest {
    pub id: String,
    pub database: String,
    pub collection: String,
    pub pipeline: Vec<Value>,
    pub options: AggregateOptions,
    pub page_size: u64,
}

/// An aggregation whose last stage (`$out` or `$merge`) writes its results.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default, deny_unknown_fields)]
pub struct AggregateWrite {
    pub id: String,
    pub database: String,
    pub collection: String,
    pub pipeline: Vec<Value>,
    pub options: AggregateOptions,
}

/// A page of documents.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct DocumentPage {
    /// Each document in canonical Extended JSON.
    pub documents: Vec<Value>,
    /// Reads the next page while the server keeps the cursor open.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cursor: Option<String>,
    /// The page stopped early at the size the interface receives at once.
    pub truncated: bool,
    pub elapsed_ms: u64,
}

/// The next page of an open cursor; `id` cancels it while it runs.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default, deny_unknown_fields)]
pub struct MoreRequest {
    pub cursor: String,
    pub id: String,
    pub page_size: u64,
}

/// A `countDocuments` with a query's filter.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default, deny_unknown_fields)]
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
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum Explained {
    Find(Box<FindRequest>),
    Aggregate {
        pipeline: Vec<Value>,
        collation: Option<Value>,
        hint: Option<Value>,
    },
}

/// An explain of a query: with `execution_stats` the server runs it to measure it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExplainRequest {
    pub id: String,
    pub database: String,
    pub collection: String,
    pub explained: Explained,
    pub execution_stats: bool,
}

/// The profiler of a database: level 0 (off), 1 (operations slower than `slowms`) or 2 (all).
#[derive(Debug, Clone, Copy, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ProfileStatus {
    pub level: i64,
    pub slowms: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sample_rate: Option<f64>,
}

/// The profiler of a database, changed first to `set` (level and `slowms`) when given.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default, deny_unknown_fields)]
pub struct ProfileRequest {
    pub database: String,
    pub set: Option<(i64, Option<i64>)>,
}

/// The slowest operations the profiler recorded in a database, or in one collection.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default, deny_unknown_fields)]
pub struct ProfiledRequest {
    pub database: String,
    pub collection: Option<String>,
    pub limit: u64,
}

/// An operation the profiler recorded.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ProfileEntry {
    pub op: String,
    pub ns: String,
    pub millis: i64,
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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub command: Option<Value>,
}
