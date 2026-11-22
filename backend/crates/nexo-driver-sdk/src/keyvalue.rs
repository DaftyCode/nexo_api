//! The `keyvalue` extension (DB-35): the methods of a key-value store such as Redis, which a
//! driver declares in `capabilities.extensions`. Keys and values travel as [`Value`]s, so a
//! key or a value that is not UTF-8 keeps its bytes (`binary`).
//!
//! - `kv.scan`: keys by pages of `SCAN`, never `KEYS`, with their type and expiry;
//! - `kv.get`: a key with its value by its type, its collections by pages;
//! - `kv.write`: creates, changes, renames, expires or deletes a key or an element;
//! - `kv.command`: one command as its arguments, the reply as a value;
//! - `kv.subscribe`, `kv.events` and `kv.unsubscribe`: channels and patterns followed,
//!   their messages read by polling.
use crate::Value;
use serde::{Deserialize, Serialize};

/// The name of the extension in `capabilities.extensions`.
pub const EXTENSION: &str = "keyvalue";

pub mod methods {
    pub const SCAN: &str = "kv.scan";
    pub const GET: &str = "kv.get";
    pub const WRITE: &str = "kv.write";
    pub const COMMAND: &str = "kv.command";
    pub const SUBSCRIBE: &str = "kv.subscribe";
    pub const EVENTS: &str = "kv.events";
    pub const UNSUBSCRIBE: &str = "kv.unsubscribe";
}

/// A page of keys.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default, deny_unknown_fields)]
pub struct ScanParams {
    pub connection: String,
    /// A glob of `SCAN MATCH` (`user:*`); every key without it.
    pub pattern: Option<String>,
    /// Only keys of this type (`string`, `hash`…).
    #[serde(rename = "type")]
    pub kind: Option<String>,
    /// Where the last page stopped; the start without it.
    pub cursor: Option<String>,
    /// About how many keys to read (`SCAN COUNT`).
    pub count: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KeyInfo {
    pub key: Value,
    #[serde(rename = "type")]
    pub kind: String,
    /// Milliseconds left; `None` when it never expires.
    pub ttl_ms: Option<i64>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ScanResult {
    pub keys: Vec<KeyInfo>,
    /// Where to go on; `None` when every key was seen.
    pub cursor: Option<String>,
}

/// A key and, for a collection, a page of its elements.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default, deny_unknown_fields)]
pub struct GetParams {
    pub connection: String,
    pub key: Value,
    /// Where the last page of a set, sorted set, hash or stream stopped.
    pub cursor: Option<String>,
    /// How many elements to read.
    pub count: Option<u32>,
}

/// An element of a collection: a list's item (`index`), a set's member, a sorted set's
/// member and `score`, a hash's `field` and value, a stream's `id` and fields.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Element {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub index: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub field: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub score: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    pub value: Value,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct KeyValue {
    pub key: Value,
    #[serde(rename = "type")]
    pub kind: String,
    pub ttl_ms: Option<i64>,
    /// How the server keeps it (`OBJECT ENCODING`).
    pub encoding: Option<String>,
    /// Bytes it takes (`MEMORY USAGE`), when the server says.
    pub size: Option<u64>,
    /// Elements of a collection, or bytes of a string.
    pub length: Option<u64>,
    /// A string's value, or a JSON document's text.
    pub value: Option<Value>,
    pub elements: Vec<Element>,
    /// Where to read the next elements from; `None` when every one was read.
    pub cursor: Option<String>,
}

/// What `kv.write` does to a key.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum WriteAction {
    /// A string's value, or a new key of `type` with its first element.
    #[default]
    Set,
    Rename,
    /// Sets the expiry (`ttlMs`), or removes it without one.
    Expire,
    Delete,
    /// Adds or changes an element.
    Put,
    /// Removes an element.
    Remove,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default, deny_unknown_fields)]
pub struct WriteParams {
    pub connection: String,
    pub key: Value,
    pub action: WriteAction,
    /// The type of a new key (`set` on a key that does not exist).
    #[serde(rename = "type")]
    pub kind: Option<String>,
    pub value: Option<Value>,
    /// A hash's field; a set's or sorted set's member to remove or replace.
    pub field: Option<Value>,
    pub score: Option<f64>,
    pub index: Option<i64>,
    /// A stream entry's fields, in order.
    pub fields: Vec<(Value, Value)>,
    /// The new name of `rename`.
    pub to: Option<Value>,
    pub ttl_ms: Option<i64>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Written {
    /// The key changed (the new name after `rename`).
    pub key: Value,
    pub done: bool,
}

/// One command, as its arguments: `["SET", "k", "v"]`.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default, deny_unknown_fields)]
pub struct CommandParams {
    pub connection: String,
    pub args: Vec<Value>,
}

/// A command's reply: text, integers, arrays, maps (as JSON objects when their keys are
/// text, pairs otherwise), `null`, and an error as `{"error": …}`.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Reply {
    pub reply: serde_json::Value,
    pub elapsed_ms: u64,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default, deny_unknown_fields)]
pub struct SubscribeParams {
    pub connection: String,
    pub channels: Vec<String>,
    pub patterns: Vec<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Subscribed {
    pub subscription: String,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default, deny_unknown_fields)]
pub struct EventsParams {
    pub connection: String,
    pub subscription: String,
    /// The last sequence number already read.
    pub after: u64,
}

/// A message of a channel.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Event {
    pub sequence: u64,
    /// `message`, `pmessage`, or `error` when the subscription broke.
    #[serde(rename = "type")]
    pub kind: String,
    pub channel: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pattern: Option<String>,
    pub payload: Value,
    /// Milliseconds since 1970.
    pub time: u64,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Events {
    /// `connected`, `closed` or `error`.
    pub state: String,
    pub events: Vec<Event>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default, deny_unknown_fields)]
pub struct UnsubscribeParams {
    pub connection: String,
    pub subscription: String,
}
