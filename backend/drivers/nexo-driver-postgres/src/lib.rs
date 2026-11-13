//! The PostgreSQL module: a driver for PostgreSQL and the servers that speak its protocol
//! (CockroachDB, YugabyteDB, TimescaleDB, Redshift in part), on tokio-postgres.
//!
//! The design of the drivers is in `docs/ARCHITECTURE.md`, section "Database modules".
mod catalog;
mod connection;
mod dialect;
mod errors;
mod execute;
mod params;
mod session;
mod tls;
mod values;

use async_trait::async_trait;
use connection::{PgConnection, not_open};
use nexo_driver_sdk::{
    Driver, DriverError, HostLink, PROTOCOL_VERSION, Result, limits,
    protocol::{
        Capabilities, ConnectParams, Ddl, DriverInfo, Hello, ObjectDescription, ObjectParams,
        ServerInfo, TreeNode,
    },
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
pub struct PostgresDriver {
    connections: Mutex<HashMap<String, Arc<PgConnection>>>,
}

impl PostgresDriver {
    fn connection(&self, name: &str) -> Result<Arc<PgConnection>> {
        let connections = self.connections.lock().unwrap();
        let connection = connections.get(name).cloned().ok_or_else(not_open)?;
        if connection.closed() {
            return Err(DriverError::closed(
                "The server closed the connection: connect again",
            ));
        }
        Ok(connection)
    }
}

#[async_trait]
impl Driver for PostgresDriver {
    fn hello(&self) -> Hello {
        Hello {
            protocol: PROTOCOL_VERSION,
            driver: DriverInfo {
                id: "postgres".into(),
                name: "PostgreSQL".into(),
                version: env!("CARGO_PKG_VERSION").into(),
            },
            capabilities: Capabilities {
                transactions: true,
                schemas: true,
                cancel: true,
                read_only_sessions: true,
                methods: Vec::new(),
                extensions: Vec::new(),
            },
            dialect: dialect::dialect(),
        }
    }

    async fn connect(&self, host: &HostLink, params: ConnectParams) -> Result<ServerInfo> {
        let name = params.connection.clone();
        if self.connections.lock().unwrap().len() >= limits::CONNECTIONS {
            return Err(DriverError::invalid(
                "Too many PostgreSQL connections are open",
            ));
        }
        let (connection, server) = PgConnection::open(host.clone(), params).await?;
        let mut connections = self.connections.lock().unwrap();
        if connections.contains_key(&name) {
            return Err(DriverError::invalid("The connection is already open"));
        }
        connections.insert(name, Arc::new(connection));
        Ok(server)
    }

    async fn disconnect(&self, connection: &str) -> Result<()> {
        // Dropping the client ends the connection, and the cursors with it.
        let removed = self.connections.lock().unwrap().remove(connection);
        removed.map(|_| ()).ok_or_else(not_open)
    }

    async fn tree(&self, params: ObjectParams) -> Result<Vec<TreeNode>> {
        let connection = self.connection(&params.connection)?;
        catalog::tree::children(&connection, &catalog::resolved(&params.path)).await
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
        let connection = self.connection(&params.connection)?;
        connection.fetch(&params.cursor, params.page_rows).await
    }

    async fn close(&self, params: CursorParams) -> Result<()> {
        self.connection(&params.connection)?
            .close(&params.cursor)
            .await
    }

    async fn cancel(&self, params: CancelParams) -> Result<()> {
        self.connection(&params.connection)?
            .cancel(&params.statement)
            .await
    }

    async fn transaction(&self, params: TransactionParams) -> Result<TransactionState> {
        let connection = self.connection(&params.connection)?;
        connection
            .transaction(params.action, params.isolation.as_deref())
            .await
    }
}
