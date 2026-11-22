//! What a Nexo database driver and its host share.
//!
//! A driver is a separate executable, downloaded when its database engine is first used.
//! Nexo starts it and talks to it over its standard input and output: one JSON message per
//! line, with requests, responses and notifications in the style of JSON-RPC 2.0. Both sides
//! may ask. The driver's standard error is its log.
//!
//! - [`protocol`] and [`statements`]: the messages; [`rows`], [`explain`], [`import`],
//!   [`search`] and [`admin`], the ones every driver answers the same way; [`keyvalue`],
//!   the extension of key-value stores, [`rest`], of the engines with an HTTP API, and
//!   [`document`], of document databases.
//! - [`value`]: values and columns that lose no type on their way to the interface.
//! - [`Driver`] and [`run`]: what a driver implements and the loop that serves it.
//! - [`Client`]: the same messages from the host's side.
//! - [`net`] and `tls`: connecting through the host's egress policy.
//!
//! Secrets reach a driver only inside `connect`, never as arguments or environment, and a
//! driver never resolves a name itself: it asks the host with `net.resolve`.

pub mod admin;
mod client;
#[cfg(feature = "conformance")]
pub mod conformance;
pub mod dashboard;
pub mod ddl;
pub mod document;
mod driver;
mod error;
pub mod explain;
#[cfg(feature = "http")]
pub mod http;
pub mod import;
pub mod keyvalue;
pub mod limits;
pub mod net;
mod peer;
pub mod protocol;
pub mod rest;
pub mod rows;
pub mod search;
mod serve;
pub mod statements;
#[cfg(test)]
mod tests;
#[cfg(feature = "tls")]
pub mod tls;
pub mod value;
pub mod wire;

pub use client::Client;
pub use driver::{Driver, HostLink};
pub use error::{DriverError, ErrorCode, Result};
pub use peer::{Handler, Peer};
pub use serve::{run, serve};
pub use value::{Column, Value, ValueKind};

/// Version of the protocol. A host refuses a driver that speaks another one.
pub const PROTOCOL_VERSION: u32 = 1;

/// Names of the methods, as they travel.
pub mod methods {
    pub const HELLO: &str = "hello";
    pub const CONNECT: &str = "connect";
    pub const DISCONNECT: &str = "disconnect";
    pub const TEST: &str = "test";
    pub const TREE: &str = "tree.children";
    pub const DESCRIBE: &str = "object.describe";
    pub const DDL: &str = "object.ddl";
    pub const EXECUTE: &str = "execute";
    pub const FETCH: &str = "fetch";
    pub const CLOSE: &str = "close";
    pub const CANCEL: &str = "cancel";
    pub const TRANSACTION: &str = "transaction";
    /// Rows changed in the data grid, written as one.
    pub const ROWS_WRITE: &str = "rows.write";
    /// The execution plan of a statement.
    pub const EXPLAIN: &str = "explain";
    /// A batch of rows imported into a table.
    pub const IMPORT: &str = "import";
    /// Objects found by name, or a value found in the data of tables.
    pub const SEARCH: &str = "search";
    /// The model of a table and the types of the engine, for the structure editor.
    pub const DDL_MODEL: &str = "ddl.model";
    /// The statements that change a table into another.
    pub const DDL_PLAN: &str = "ddl.plan";
    /// The sessions open on the server.
    pub const SESSIONS: &str = "sessions";
    /// Who waits for a lock another session holds.
    pub const LOCKS: &str = "locks";
    /// Cancels the statement of a session of the server, or ends the session.
    pub const KILL: &str = "kill";
    /// The panels of the server's dashboard the driver offers.
    pub const DASHBOARDS: &str = "dashboards";
    /// Asked by the driver: the addresses of a host it may connect to.
    pub const NET_RESOLVE: &str = "net.resolve";
    /// Whether a server may be reached, for a driver whose library connects by name
    /// (MongoDB): the host checks it as `net.resolve` does, without resolving it for the
    /// driver.
    pub const NET_CHECK: &str = "net.check";
    /// Notified by the driver: a line for the host's log.
    pub const LOG: &str = "log";
}
