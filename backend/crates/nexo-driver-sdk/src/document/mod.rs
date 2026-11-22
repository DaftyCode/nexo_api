//! The `document` extension (DB-39): the methods of a document database such as MongoDB,
//! which a driver declares in `capabilities.extensions`. There is one method for each method
//! of the application's document database port, with the same types: documents, filters
//! and pipelines travel in Extended JSON, so no BSON type is lost.
//!
//! A connection is opened with `connect` like any other: its URI goes in the option `uri`,
//! and its SOCKS5 proxy, when its route has one, in `proxy`. Every server the driver
//! contacts is checked first with `net.check`, because its library connects by name.
//!
//! Each request names the connection it goes to ([`On`]). Cursors, running queries and
//! change streams are named by the driver, and the host remembers which connection holds
//! each one.
mod browse;
mod queries;
mod watch;
mod writes;

pub use browse::*;
pub use queries::*;
pub use watch::*;
pub use writes::*;

use serde::{Deserialize, Serialize};

/// The name of the extension in `capabilities.extensions`.
pub const EXTENSION: &str = "document";

/// The options of `connect` a document driver reads.
pub mod options {
    /// The connection string, without its password.
    pub const URI: &str = "uri";
    /// `true` when some servers may be refused (a restrictive egress policy, or secrets that
    /// may only reach some hosts): the first server is asked for the others before the
    /// driver connects to them all.
    pub const CHECK_MEMBERS: &str = "checkMembers";
}

pub mod methods {
    /// What the connection found when it opened: [`super::ConnectionReport`].
    pub const REPORT: &str = "document.report";
    pub const DATABASES: &str = "document.databases";
    pub const COLLECTIONS: &str = "document.collections";
    pub const STATS: &str = "document.stats";
    pub const FIND: &str = "document.find";
    pub const MORE: &str = "document.more";
    pub const COUNT: &str = "document.count";
    pub const AGGREGATE: &str = "document.aggregate";
    pub const AGGREGATE_WRITE: &str = "document.aggregateWrite";
    pub const CANCEL: &str = "document.cancel";
    pub const CLOSE: &str = "document.close";
    pub const WRITE: &str = "document.write";
    pub const CHANGE: &str = "document.change";
    pub const INDEXES: &str = "document.indexes";
    pub const INDEX: &str = "document.index";
    pub const EXPLAIN: &str = "document.explain";
    pub const PROFILE: &str = "document.profile";
    pub const PROFILED: &str = "document.profiled";
    pub const WATCH: &str = "document.watch";
    pub const WATCH_EVENTS: &str = "document.watchEvents";
    pub const WATCH_CLOSE: &str = "document.watchClose";
    pub const WATCHES: &str = "document.watches";
    pub const IMPORT: &str = "document.import";
}

/// A request to a connection; `()` (`null`) for the methods that need nothing else.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct On<T> {
    pub connection: String,
    pub request: T,
}

/// A database of the connection.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DatabaseName {
    pub database: String,
}

/// A collection of a database.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CollectionName {
    pub database: String,
    pub collection: String,
}

/// Something the driver named: a cursor, a running query or a change stream.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Named {
    pub id: String,
}

#[cfg(test)]
mod tests;
