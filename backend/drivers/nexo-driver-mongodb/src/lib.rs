//! The MongoDB module (DB-39): MongoDB and the servers compatible with it (FerretDB, Amazon
//! DocumentDB, Azure Cosmos DB) through the official driver, with rustls on aws-lc-rs. It
//! was built into Nexo until it became a module, and does what it did then: MongoDB is not
//! SQL, so besides the protocol every driver speaks (its tree lists databases and
//! collections) it answers the `document` extension of the SDK, one method for each method
//! of the application's document database port.
//!
//! Its library connects to servers by name and can be given no address, so every server is
//! checked with the host first (`net.check`), and a connection with a route goes through the
//! SOCKS5 proxy the host gives it in `connect`.
//!
//! The design (dependencies, egress policy, certificates, limits, redaction) is written in
//! `docs/ARCHITECTURE.md`, section "Database modules".

mod browse;
mod connection;
mod deployment;
mod error;
mod errors;
mod explain;
mod extension;
mod indexes;
mod open;
mod profiler;
mod query;
mod tls;
mod tree;
mod watch;
mod write;

#[cfg(test)]
use deployment::flavor;
use deployment::{address, client, command, describe, members};

use async_trait::async_trait;
use connection::DatabaseConnection;
use error::{Error, Result};
use mongodb::{
    Client,
    bson::{Document, doc},
    options::{ClientOptions, ServerAddress},
};
use nexo_driver_sdk::document::{ConnectionReport, DatabaseHost};
use nexo_driver_sdk::{
    Driver, DriverError, HostLink, PROTOCOL_VERSION, document,
    protocol::{
        Capabilities, ConnectParams, Dialect, DriverInfo, Hello, ObjectParams, ServerInfo, TreeNode,
    },
    statements::{CursorParams, ExecuteParams, ExecuteResult, FetchParams, Page},
};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::Instant,
};
use tls::{TlsFiles, TlsFolder};

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
    /// How long the cursor of a page nobody reads stays open.
    pub const IDLE: Duration = Duration::from_secs(10 * 60);
    /// Cursors kept open at once; the oldest is closed first.
    pub const CURSORS: usize = 32;
}

/// A connection open in the driver, with what was checked to open it and the certificates
/// it was opened with.
struct Open {
    client: Client,
    /// The database named in the URI, listed when the user may not list them all.
    default_database: Option<String>,
    options: ClientOptions,
    seeds: Vec<(String, u16)>,
    direct: bool,
    /// Why each server may not be reached, if it may not, as the host answered.
    refusals: tokio::sync::Mutex<HashMap<String, Option<String>>>,
    connection: DatabaseConnection,
    _files: TlsFiles,
}

/// The MongoDB driver. Certificates of a connection are written under its own temporary
/// folder while it is open; cursors, running queries and change streams are kept for the
/// whole process and named so that no two connections share a name.
pub struct MongoDriver {
    tls_directory: TlsFolder,
    connections: Mutex<HashMap<String, Arc<Open>>>,
    cursors: Mutex<HashMap<String, query::Stored>>,
    running: Mutex<HashMap<String, query::Running>>,
    watches: Mutex<HashMap<String, watch::Watching>>,
}

impl Default for MongoDriver {
    fn default() -> Self {
        Self {
            tls_directory: TlsFolder::new(),
            connections: Default::default(),
            cursors: Default::default(),
            running: Default::default(),
            watches: Default::default(),
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

fn not_open() -> Error {
    Error::Validation("The connection is not open".into())
}

impl MongoDriver {
    /// The client of an open connection, and the database its URI names.
    fn client(&self, name: &str) -> Result<(Client, Option<String>)> {
        let open = self.open(name)?;
        Ok((open.client.clone(), open.default_database.clone()))
    }
    fn open(&self, name: &str) -> Result<Arc<Open>> {
        self.connections
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .get(name)
            .cloned()
            .ok_or_else(not_open)
    }
}

fn unsupported<T>() -> nexo_driver_sdk::Result<T> {
    Err(DriverError::unsupported(
        "MongoDB is not SQL: its collections open in their own tabs",
    ))
}

#[async_trait]
impl Driver for MongoDriver {
    fn hello(&self) -> Hello {
        Hello {
            protocol: PROTOCOL_VERSION,
            driver: DriverInfo {
                id: "mongodb".into(),
                name: "MongoDB".into(),
                version: env!("CARGO_PKG_VERSION").into(),
            },
            capabilities: Capabilities {
                cancel: true,
                extensions: vec![document::EXTENSION.into()],
                ..Capabilities::default()
            },
            dialect: Dialect {
                name: "mongodb".into(),
                ..Dialect::default()
            },
        }
    }

    async fn connect(
        &self,
        host: &HostLink,
        params: ConnectParams,
    ) -> nexo_driver_sdk::Result<ServerInfo> {
        if self.connections.lock().unwrap().len() >= nexo_driver_sdk::limits::CONNECTIONS {
            return Err(DriverError::invalid(
                "Too many MongoDB connections are open",
            ));
        }
        let connection = DatabaseConnection::from_params(&params)?;
        let opened = within(self.connect_to(host, &connection)).await?;
        let tls = matches!(opened.options.tls, Some(mongodb::options::Tls::Enabled(_)));
        let open = Open {
            client: opened.client,
            default_database: opened.options.default_database.clone(),
            options: opened.options,
            seeds: opened.seeds,
            direct: opened.direct,
            refusals: tokio::sync::Mutex::new(opened.refusals),
            connection,
            _files: opened.files,
        };
        let database = open.default_database.clone();
        self.connections
            .lock()
            .unwrap()
            .insert(params.connection, Arc::new(open));
        // MongoDB's client connects when it is first used: nothing is asked of the server yet.
        Ok(ServerInfo {
            database,
            tls,
            ..ServerInfo::default()
        })
    }

    async fn disconnect(&self, connection: &str) -> nexo_driver_sdk::Result<()> {
        let removed = self.connections.lock().unwrap().remove(connection);
        removed.map(|_| ()).ok_or_else(|| not_open().into())
    }

    async fn tree(&self, params: ObjectParams) -> nexo_driver_sdk::Result<Vec<TreeNode>> {
        let (client, default_database) = self.client(&params.connection)?;
        Ok(within(tree::children(&client, default_database, &params.path)).await?)
    }

    async fn execute(&self, _params: ExecuteParams) -> nexo_driver_sdk::Result<ExecuteResult> {
        unsupported()
    }
    async fn fetch(&self, _params: FetchParams) -> nexo_driver_sdk::Result<Page> {
        unsupported()
    }
    async fn close(&self, _params: CursorParams) -> nexo_driver_sdk::Result<()> {
        unsupported()
    }

    async fn extension(
        &self,
        host: &HostLink,
        method: &str,
        params: serde_json::Value,
    ) -> nexo_driver_sdk::Result<serde_json::Value> {
        self.answer(host, method, params).await
    }
}

#[cfg(test)]
mod tests;
