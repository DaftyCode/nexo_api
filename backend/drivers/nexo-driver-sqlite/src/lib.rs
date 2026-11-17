//! The SQLite module: a driver for the SQLite database in a file of this computer that the
//! person chose, on the workspace's rusqlite (with SQLite bundled).
//!
//! The design of the drivers is in `docs/ARCHITECTURE.md`, section "Database modules".
mod catalog;
mod connection;
mod ddl;
mod dialect;
mod errors;
mod file;
mod guard;
mod plan;
mod search;
mod session;
mod values;

use async_trait::async_trait;
use connection::{SqliteConnection, not_open};
use nexo_driver_sdk::{
    Driver, DriverError, HostLink, PROTOCOL_VERSION, Result,
    ddl::{DdlModel, DdlModelParams, DdlPlan, DdlPlanParams},
    explain::{ExplainMode, ExplainParams, Plan},
    limits, methods,
    protocol::{
        Capabilities, ConnectParams, Ddl, DriverInfo, Hello, ObjectDescription, ObjectParams,
        ServerInfo, TreeNode,
    },
    search::{SearchParams, SearchResult},
    statements::{
        CancelParams, CursorParams, ExecuteParams, ExecuteResult, FetchParams, Page,
        TransactionParams, TransactionState,
    },
};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};

#[derive(Default)]
pub struct SqliteDriver {
    connections: Mutex<HashMap<String, Arc<SqliteConnection>>>,
}

impl SqliteDriver {
    fn connection(&self, name: &str) -> Result<Arc<SqliteConnection>> {
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
impl Driver for SqliteDriver {
    fn hello(&self) -> Hello {
        Hello {
            protocol: PROTOCOL_VERSION,
            driver: DriverInfo {
                id: "sqlite".into(),
                name: "SQLite".into(),
                version: env!("CARGO_PKG_VERSION").into(),
            },
            capabilities: Capabilities {
                transactions: true,
                schemas: false,
                cancel: true,
                read_only_sessions: true,
                isolation_levels: ["deferred", "immediate", "exclusive"]
                    .map(String::from)
                    .to_vec(),
                ddl_commits: false,
                explain: vec![ExplainMode::Estimated],
                methods: [methods::DDL_MODEL, methods::DDL_PLAN]
                    .map(String::from)
                    .to_vec(),
                extensions: Vec::new(),
            },
            dialect: dialect::dialect(),
        }
    }

    /// Opens the file of the connection; it reaches no network, so it asks the host nothing.
    async fn connect(&self, _host: &HostLink, params: ConnectParams) -> Result<ServerInfo> {
        let name = params.connection.clone();
        if self.connections.lock().unwrap().len() >= limits::CONNECTIONS {
            return Err(DriverError::invalid("Too many SQLite connections are open"));
        }
        if self.connections.lock().unwrap().contains_key(&name) {
            return Err(DriverError::invalid("The connection is already open"));
        }
        let (connection, server) = SqliteConnection::open(params).await?;
        let mut connections = self.connections.lock().unwrap();
        if connections.contains_key(&name) {
            return Err(DriverError::invalid("The connection is already open"));
        }
        connections.insert(name, Arc::new(connection));
        Ok(server)
    }

    async fn disconnect(&self, connection: &str) -> Result<()> {
        // Dropping the connection ends its thread, which closes the file.
        let removed = self.connections.lock().unwrap().remove(connection);
        removed.map(|_| ()).ok_or_else(not_open)
    }

    async fn tree(&self, params: ObjectParams) -> Result<Vec<TreeNode>> {
        let connection = self.connection(&params.connection)?;
        catalog::tree::children(&connection, &params.path).await
    }

    async fn describe(&self, params: ObjectParams) -> Result<ObjectDescription> {
        let connection = self.connection(&params.connection)?;
        catalog::describe::describe(&connection, &params.path).await
    }

    async fn ddl(&self, params: ObjectParams) -> Result<Ddl> {
        let connection = self.connection(&params.connection)?;
        catalog::ddl::ddl(&connection, &params.path).await
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

    async fn transaction(&self, params: TransactionParams) -> Result<TransactionState> {
        self.connection(&params.connection)?
            .transaction(params.action, params.isolation)
            .await
    }

    async fn explain(&self, params: ExplainParams) -> Result<Plan> {
        nexo_driver_sdk::explain::run(self, params, &plan::SqlitePlans).await
    }

    async fn ddl_model(&self, params: DdlModelParams) -> Result<DdlModel> {
        let connection = self.connection(&params.connection)?;
        ddl::model(&connection, &params.path).await
    }

    async fn ddl_plan(&self, params: DdlPlanParams) -> Result<DdlPlan> {
        nexo_driver_sdk::ddl::plan(&ddl::writer::SqliteWriter, &params)
    }

    async fn search(&self, params: SearchParams) -> Result<SearchResult> {
        nexo_driver_sdk::search::run(self, params, &search::SqliteSearch).await
    }
}
