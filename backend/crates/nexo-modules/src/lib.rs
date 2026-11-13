//! Database modules: every database engine is a driver in its own process, a separate
//! executable that Nexo does not carry. This crate starts those processes and talks to them
//! with the protocol of `nexo-driver-sdk`.
//!
//! - A driver gets no arguments and an almost empty environment. Secrets reach it only in
//!   the `connect` message.
//! - A driver never resolves a name: it asks, and [`DriverHost`] answers with the addresses
//!   the egress policy and the connection's secrets allow.
//! - What a driver writes to its log, and the errors it answers, are shown without the
//!   secrets of its connections.
//! - A driver stops with Nexo: it ends when its input does, and is killed if it does not.
//!
//! The design is in `docs/ARCHITECTURE.md`, section "Database modules".

mod connections;
mod host;
mod process;
mod redact;
mod resolve;

pub use host::{DriverHost, HostConfig, LogSink};
