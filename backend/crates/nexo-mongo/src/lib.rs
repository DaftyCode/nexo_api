//! MongoDB adapter: implements the application's document database port with the official
//! driver. Nothing outside this crate depends on `mongodb`; `nexo-server` composes it.
//!
//! The design (dependencies, egress policy, certificates, limits, redaction) is written in
//! `docs/ARCHITECTURE.md`, section "MongoDB".

mod adapter;
mod database;
mod deployment;
#[cfg(test)]
use deployment::flavor;
use deployment::{address, client, command, describe, members};

mod browse;
mod connection;
mod errors;
mod explain;
mod indexes;
mod profiler;
mod query;
mod tls;
mod write;

use async_trait::async_trait;
use mongodb::{
    Client,
    bson::{Document, doc},
    options::{ClientOptions, ServerAddress},
};
use nexo_application::ports::{
    CollectionChange, CollectionStats, CollectionSummary, ConnectionReport, CountRequest,
    DatabaseConnection, DatabaseHost, DatabaseSummary, DocumentDatabase, DocumentPage,
    DocumentWrite, ExplainRequest, FindRequest, ImportBatch, ImportResult, IndexChange,
    IndexDetail, NetworkPolicy, ProfileEntry, ProfileStatus, WriteResult, WriteTarget,
};
use nexo_domain::{Error, Result};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::Instant,
};
use tls::TlsFiles;

/// Limits of every connection, so the interface and the engine stay responsive.
pub mod limits {
    use std::time::Duration;
    /// How long to wait for a server to answer before giving up on it.
    pub const SERVER_SELECTION: Duration = Duration::from_secs(10);
    /// How long to wait to open a connection.
    pub const CONNECT: Duration = Duration::from_secs(10);
    /// How long one operation may run before it is cancelled (`maxTimeMS`).
    pub const OPERATION: Duration = Duration::from_secs(60);
    /// Documents in a page of results.
    pub const PAGE_DOCUMENTS: u64 = 1_000;
    /// Bytes of results sent to the interface at once.
    pub const RESPONSE_BYTES: usize = 16 * 1024 * 1024;
    /// Connections per server: one person, a few panels.
    pub const POOL: u32 = 4;
    /// How long an unused connection, or the cursor of a page nobody reads, stays open.
    pub const IDLE: Duration = Duration::from_secs(10 * 60);
    /// Connections kept open at once.
    pub const CLIENTS: usize = 8;
    /// Cursors kept open at once; the oldest is closed first.
    pub const CURSORS: usize = 32;
}

/// A connection kept open for the explorer, with the certificates it was opened with.
struct Open {
    client: Client,
    /// The database named in the URI, listed when the user may not list them all.
    default_database: Option<String>,
    used: Instant,
    _files: TlsFiles,
}

/// The MongoDB adapter. Certificates of a connection are written under `tls_directory` while
/// it is open.
pub struct MongoAdapter {
    tls_directory: PathBuf,
    policy: Arc<dyn NetworkPolicy>,
    /// Open connections, by everything that identifies them (secrets included, in memory).
    clients: tokio::sync::Mutex<HashMap<String, Open>>,
    cursors: Mutex<HashMap<String, query::Stored>>,
    running: Mutex<HashMap<String, query::Running>>,
}

impl MongoAdapter {
    pub fn new(data: &Path, policy: Arc<dyn NetworkPolicy>) -> Self {
        let tls_directory = data.join("mongo-tls");
        // Certificates left by a previous run that ended abruptly.
        let _ = std::fs::remove_dir_all(&tls_directory);
        Self {
            tls_directory,
            policy,
            clients: Default::default(),
            cursors: Default::default(),
            running: Default::default(),
        }
    }
}

/// A connection just opened, with what was checked to open it.
struct Opened {
    client: Client,
    options: ClientOptions,
    files: TlsFiles,
    seeds: Vec<(String, u16)>,
    direct: bool,
    refusals: HashMap<String, Option<String>>,
}

/// Waits for an operation for at most the operation limit (and a little more, so the
/// server's `maxTimeMS` answers first).
async fn within<T>(work: impl std::future::Future<Output = Result<T>>) -> Result<T> {
    tokio::time::timeout(limits::OPERATION + std::time::Duration::from_secs(5), work)
        .await
        .map_err(|_| {
            Error::Validation(format!(
                "The server did not answer within {} seconds",
                limits::OPERATION.as_secs()
            ))
        })?
}

#[cfg(test)]
mod tests;
