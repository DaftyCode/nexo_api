//! Change streams of a document database, read like the realtime panel's connections: each
//! is a session whose events the interface reads by polling.
use serde::Serialize;
use serde_json::Value;

/// The start of the identifier of every change stream session, so the realtime operations
/// (`realtime.poll`, `realtime.close`, `realtime.list`) reach the database instead of the
/// engine.
pub const WATCH_PREFIX: &str = "mongo-watch-";

/// What a change stream watches and what each change carries. Without a database it watches
/// the whole deployment; without a collection, the whole database.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct WatchRequest {
    pub database: Option<String>,
    pub collection: Option<String>,
    /// Stages that filter or shape the changes (`$match`, `$project`…), in Extended JSON.
    pub pipeline: Vec<Value>,
    /// `default`, `updateLookup`, `whenAvailable` or `required`.
    pub full_document: Option<String>,
    /// `off`, `whenAvailable` or `required`.
    pub full_document_before_change: Option<String>,
    /// Starts after this change instead of now: a resume token (`{_data: …}`).
    pub resume_after: Option<Value>,
}

/// The events of a change stream after a sequence number, as `realtime.poll` answers.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct WatchEvents {
    pub id: String,
    /// `connecting`, `connected`, `closed` or `error`.
    pub state: String,
    /// `{sequence, type, data, time}`: `type` is the change's `operationType`.
    pub events: Vec<Value>,
}

/// A change stream as `realtime.list` lists it.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct WatchSummary {
    pub id: String,
    pub protocol: String,
    /// What it watches (`shop.orders`, `shop`, or the deployment), never the URI.
    pub url: String,
    pub state: String,
}
