//! The files module (DB-30): CSV, TSV, JSON, Parquet and Excel files as tables, joined with
//! SQL, and DuckDB databases, on DuckDB compiled in (without its network extensions). A
//! connection reads only its own files: DuckDB's external access is off but for their paths,
//! no extension is installed or loaded, its settings are locked, and files are only read.
//!
//! The design of the drivers is in `docs/ARCHITECTURE.md`, section "Database modules".
mod catalog;
mod connection;
mod dialect;
mod excel;
mod guard;
mod session;
mod target;
mod values;

pub use target::SETTINGS;

use async_trait::async_trait;
use connection::{FilesConnection, not_open};
use nexo_driver_sdk::{
    Driver, DriverError, HostLink, PROTOCOL_VERSION, Result, limits,
    protocol::{
        Capabilities, ConnectParams, Ddl, DriverInfo, Hello, ObjectDescription, ObjectParams,
        ServerInfo, TreeNode,
    },
    statements::{CancelParams, CursorParams, ExecuteParams, ExecuteResult, FetchParams, Page},
};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};

#[derive(Default)]
pub struct FilesDriver {
    connections: Mutex<HashMap<String, Arc<FilesConnection>>>,
}

impl FilesDriver {
    fn connection(&self, name: &str) -> Result<Arc<FilesConnection>> {
        let connections = self.connections.lock().unwrap();
        let connection = connections.get(name).cloned().ok_or_else(not_open)?;
        if connection.closed() {
            return Err(DriverError::closed(
                "The connection was closed: connect again",
            ));
        }
        Ok(connection)
    }
}

#[async_trait]
impl Driver for FilesDriver {
    fn hello(&self) -> Hello {
        Hello {
            protocol: PROTOCOL_VERSION,
            driver: DriverInfo {
                id: "files".into(),
                name: "Files and DuckDB".into(),
                version: env!("CARGO_PKG_VERSION").into(),
            },
            capabilities: Capabilities {
                transactions: false,
                schemas: true,
                cancel: true,
                read_only_sessions: true,
                isolation_levels: Vec::new(),
                ddl_commits: false,
                explain: Vec::new(),
                methods: Vec::new(),
                kill: Vec::new(),
                extensions: Vec::new(),
            },
            dialect: dialect::dialect(),
        }
    }

    /// Opens the files or the database of the connection; it reaches no network.
    async fn connect(&self, _host: &HostLink, params: ConnectParams) -> Result<ServerInfo> {
        let name = params.connection.clone();
        if self.connections.lock().unwrap().len() >= limits::CONNECTIONS {
            return Err(DriverError::invalid(
                "Too many connections to files are open",
            ));
        }
        if self.connections.lock().unwrap().contains_key(&name) {
            return Err(DriverError::invalid("The connection is already open"));
        }
        let (connection, server) = FilesConnection::open(params).await?;
        let mut connections = self.connections.lock().unwrap();
        if connections.contains_key(&name) {
            return Err(DriverError::invalid("The connection is already open"));
        }
        connections.insert(name, Arc::new(connection));
        Ok(server)
    }

    async fn disconnect(&self, connection: &str) -> Result<()> {
        let removed = self.connections.lock().unwrap().remove(connection);
        removed.map(|_| ()).ok_or_else(not_open)
    }

    async fn tree(&self, params: ObjectParams) -> Result<Vec<TreeNode>> {
        let connection = self.connection(&params.connection)?;
        catalog::children(&connection, &params.path).await
    }
    async fn describe(&self, params: ObjectParams) -> Result<ObjectDescription> {
        let connection = self.connection(&params.connection)?;
        catalog::describe(&connection, &params.path).await
    }
    async fn ddl(&self, params: ObjectParams) -> Result<Ddl> {
        let connection = self.connection(&params.connection)?;
        catalog::ddl(&connection, &params.path).await
    }
    async fn execute(&self, params: ExecuteParams) -> Result<ExecuteResult> {
        self.connection(&params.connection)?.execute(params).await
    }
    async fn fetch(&self, params: FetchParams) -> Result<Page> {
        let rows = limits::page_rows(params.page_rows) as u64;
        self.connection(&params.connection)?
            .fetch(params.cursor, rows)
            .await
    }
    async fn close(&self, params: CursorParams) -> Result<()> {
        self.connection(&params.connection)?
            .close(params.cursor)
            .await
    }
    async fn cancel(&self, params: CancelParams) -> Result<()> {
        self.connection(&params.connection)?
            .cancel(&params.statement);
        Ok(())
    }
}
