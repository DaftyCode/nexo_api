//! What a Nexo database driver and its host share.
//!
//! A driver is a separate executable, downloaded when its database engine is first used.
//! Nexo starts it and talks to it over its standard input and output: one JSON message per
//! line, with requests, responses and notifications in the style of JSON-RPC 2.0. Both sides
//! may ask. The driver's standard error is its log.
//!
//! - [`protocol`] and [`statements`]: the messages.
//! - [`value`]: values and columns that lose no type on their way to the interface.
//! - [`Driver`] and [`run`]: what a driver implements and the loop that serves it.
//! - [`Client`]: the same messages from the host's side.
//! - [`net`] and `tls`: connecting through the host's egress policy.
//!
//! Secrets reach a driver only inside `connect`, never as arguments or environment, and a
//! driver never resolves a name itself: it asks the host with `net.resolve`.

mod client;
#[cfg(feature = "conformance")]
pub mod conformance;
mod driver;
mod error;
pub mod limits;
pub mod net;
mod peer;
pub mod protocol;
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
    /// Asked by the driver: the addresses of a host it may connect to.
    pub const NET_RESOLVE: &str = "net.resolve";
    /// Notified by the driver: a line for the host's log.
    pub const LOG: &str = "log";
}
