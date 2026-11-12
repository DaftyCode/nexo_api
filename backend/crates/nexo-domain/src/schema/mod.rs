//! The schema of a set of documents, read from the documents themselves: each field path with
//! how often it is present, its types and their share, its most frequent values, the minimum
//! and maximum of each type and the lengths of strings and arrays, and what looks wrong (a
//! field of several types, a field missing from a few documents). It reads MongoDB documents
//! in canonical Extended JSON and plain JSON alike (B-08 uses it for API responses), and
//! writes the schema as JSON Schema or a MongoDB `$jsonSchema` validator.
//!
//! Paths use dots; the items of an array are the segment `[]` (`items.[].sku`).
mod generate;
mod types;
mod walk;

#[cfg(test)]
mod tests;

pub use generate::{SchemaDialect, json_schema};
pub use types::type_name;
pub use walk::analyze;

use serde::Serialize;
use serde_json::Value;

/// How values are read: canonical Extended JSON (`{$oid: …}` is an ObjectId) or plain JSON.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Flavor {
    Bson,
    Json,
}

/// Most frequent values reported for a field.
pub const TOP_VALUES: usize = 10;
/// Different values counted for a field; later new values are not counted.
pub const TRACKED_VALUES: usize = 1_000;
/// Field paths reported at most: documents with keys made of data stop growing the schema.
pub const MAX_FIELDS: usize = 1_000;
/// Nesting read at most, as in BSON.
const MAX_DEPTH: usize = 100;
/// Text longer than this is not counted among the frequent values.
const LONG_VALUE: usize = 200;
/// A field present in at least this share of the documents, and not all, is an anomaly.
const ALMOST_ALWAYS: f64 = 0.9;
/// Fewer documents than this do not tell a field is almost always present.
const FEW: u64 = 10;

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SchemaReport {
    /// Documents read.
    pub sampled: u64,
    /// Each field path, a parent before its fields, siblings in the order first seen.
    pub fields: Vec<FieldSchema>,
    /// More than `MAX_FIELDS` paths were found: the others are left out.
    pub truncated: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FieldSchema {
    pub path: String,
    pub name: String,
    pub depth: usize,
    /// Documents (or embedded documents, or array items) where it is present.
    pub count: u64,
    /// Documents (or embedded documents, or array items) where it could be.
    pub parents: u64,
    /// Its types, the most frequent first.
    pub types: Vec<TypeSummary>,
    /// Its most frequent values, the most frequent first.
    pub values: Vec<ValueCount>,
    /// Different values counted.
    pub distinct: u64,
    /// There were more different values than were counted.
    pub distinct_capped: bool,
    pub anomalies: Vec<Anomaly>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TypeSummary {
    pub name: String,
    pub count: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub min: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max: Option<Value>,
    /// Characters of strings, items of arrays.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lengths: Option<Lengths>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Lengths {
    pub min: u64,
    pub max: u64,
    pub average: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ValueCount {
    pub value: Value,
    pub count: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Anomaly {
    /// Values of more than one type, besides null.
    MixedTypes,
    /// Present in almost every document, but missing in some.
    SometimesMissing,
}
