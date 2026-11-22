//! Change streams, read by polling like the realtime panel's connections.
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// The start of the identifier of every change stream, so the realtime operations reach the
/// database instead of the engine.
pub const WATCH_PREFIX: &str = "mongo-watch-";

/// What a change stream watches: without a database the whole deployment; without a
/// collection, the whole database.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default, deny_unknown_fields)]
pub struct WatchRequest {
    pub database: Option<String>,
    pub collection: Option<String>,
    pub pipeline: Vec<Value>,
    /// `default`, `updateLookup`, `whenAvailable` or `required`.
    pub full_document: Option<String>,
    /// `off`, `whenAvailable` or `required`.
    pub full_document_before_change: Option<String>,
    /// Starts after this change instead of now: a resume token (`{_data: …}`).
    pub resume_after: Option<Value>,
}

/// The events of a change stream after the sequence number `after`.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default, deny_unknown_fields)]
pub struct EventsRequest {
    pub id: String,
    pub after: u64,
}

/// The events of a change stream, as `realtime.poll` answers.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct WatchEvents {
    pub id: String,
    /// `connecting`, `connected`, `closed` or `error`.
    pub state: String,
    /// `{sequence, type, data, time}`.
    pub events: Vec<Value>,
}

/// A change stream as `realtime.list` lists it.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct WatchSummary {
    pub id: String,
    pub protocol: String,
    /// What it watches (`shop.orders`, `shop`, or the deployment), never the URI.
    pub url: String,
    pub state: String,
}
