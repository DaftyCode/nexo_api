//! The MySQL module: a driver for MySQL, MariaDB and the servers that speak their protocol
//! (Percona Server, TiDB, SingleStore in part), on mysql_async.
//!
//! The design of the drivers is in `docs/ARCHITECTURE.md`, section "Database modules".
mod admin;
mod catalog;
mod connection;
mod ddl;
mod dialect;
mod errors;
mod plan;
mod search;
mod session;
mod values;

use async_trait::async_trait;
use connection::{MyConnection, not_open};
use nexo_driver_sdk::{
    Driver, DriverError, HostLink, PROTOCOL_VERSION, Result,
    admin::{AdminParams, KillMode, KillParams, Killed, LockList, SessionList},
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
pub struct MysqlDriver {
    connections: Mutex<HashMap<String, Arc<MyConnection>>>,
}

impl MysqlDriver {
    fn connection(&self, name: &str) -> Result<Arc<MyConnection>> {
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
impl Driver for MysqlDriver {
    fn hello(&self) -> Hello {
        Hello {
            protocol: PROTOCOL_VERSION,
            driver: DriverInfo {
                id: "mysql".into(),
                name: "MySQL".into(),
                version: env!("CARGO_PKG_VERSION").into(),
            },
            capabilities: Capabilities {
                transactions: true,
                // A MySQL database is what other engines call a schema: the tree shows them.
                schemas: false,
                cancel: true,
                read_only_sessions: true,
                isolation_levels: [
                    "read uncommitted",
                    "read committed",
                    "repeatable read",
                    "serializable",
                ]
                .map(String::from)
                .to_vec(),
                ddl_commits: true,
                explain: vec![ExplainMode::Estimated, ExplainMode::Actual],
                methods: [
                    methods::DDL_MODEL,
                    methods::DDL_PLAN,
                    methods::SESSIONS,
                    methods::LOCKS,
                    methods::KILL,
                ]
                .map(String::from)
                .to_vec(),
                kill: vec![KillMode::Cancel, KillMode::Terminate],
                extensions: Vec::new(),
            },
            dialect: dialect::dialect(),
        }
    }

    async fn connect(&self, host: &HostLink, params: ConnectParams) -> Result<ServerInfo> {
        let name = params.connection.clone();
        if self.connections.lock().unwrap().len() >= limits::CONNECTIONS {
            return Err(DriverError::invalid("Too many MySQL connections are open"));
        }
        let (connection, server) = MyConnection::open(host.clone(), params).await?;
        let mut connections = self.connections.lock().unwrap();
        if connections.contains_key(&name) {
            return Err(DriverError::invalid("The connection is already open"));
        }
        connections.insert(name, Arc::new(connection));
        Ok(server)
    }

    async fn disconnect(&self, connection: &str) -> Result<()> {
        // Dropping the connection ends its session, and the server's connection with it.
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
            .cancel(&params.statement)
            .await
    }

    async fn transaction(&self, params: TransactionParams) -> Result<TransactionState> {
        self.connection(&params.connection)?
            .transaction(params.action, params.isolation)
            .await
    }

    async fn explain(&self, params: ExplainParams) -> Result<Plan> {
        let server = self.connection(&params.connection)?.server;
        // MySQL measures no single-table change; MariaDB's `ANALYZE` measures any.
        if params.mode == ExplainMode::Actual && params.writes && !server.mariadb {
            return Err(DriverError::unsupported(
                "MySQL measures only queries: explain this change without running it",
            ));
        }
        nexo_driver_sdk::explain::run(self, params, &plan::MysqlPlans { server }).await
    }

    async fn ddl_model(&self, params: DdlModelParams) -> Result<DdlModel> {
        let connection = self.connection(&params.connection)?;
        ddl::model(&connection, &params.path).await
    }

    async fn ddl_plan(&self, params: DdlPlanParams) -> Result<DdlPlan> {
        nexo_driver_sdk::ddl::plan(&ddl::writer::MysqlWriter, &params)
    }

    async fn search(&self, params: SearchParams) -> Result<SearchResult> {
        nexo_driver_sdk::search::run(self, params, &search::MysqlSearch).await
    }

    async fn sessions(&self, params: AdminParams) -> Result<SessionList> {
        let server = self.connection(&params.connection)?.server;
        nexo_driver_sdk::admin::sessions(self, params, &admin::MysqlAdmin { server }).await
    }

    async fn locks(&self, params: AdminParams) -> Result<LockList> {
        let server = self.connection(&params.connection)?.server;
        nexo_driver_sdk::admin::locks(self, params, &admin::MysqlAdmin { server }).await
    }

    async fn kill(&self, params: KillParams) -> Result<Killed> {
        let server = self.connection(&params.connection)?.server;
        nexo_driver_sdk::admin::kill(self, params, &admin::MysqlAdmin { server }).await
    }
}
