//! The PostgreSQL module: a driver for PostgreSQL and the servers that speak its protocol
//! (CockroachDB, YugabyteDB, TimescaleDB, Redshift in part), on tokio-postgres.
//!
//! The design of the drivers is in `docs/ARCHITECTURE.md`, section "Database modules".
mod admin;
mod catalog;
mod connection;
mod dashboards;
mod ddl;
mod dialect;
mod errors;
mod execute;
mod params;
mod plan;
mod search;
mod session;
mod tls;
mod values;

use async_trait::async_trait;
use connection::{PgConnection, not_open};
use nexo_driver_sdk::{
    Driver, DriverError, HostLink, PROTOCOL_VERSION, Result,
    admin::{AdminParams, KillMode, KillParams, Killed, LockList, SessionList},
    dashboard::{DashboardParams, Dashboards},
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
                isolation_levels: [
                    "read uncommitted",
                    "read committed",
                    "repeatable read",
                    "serializable",
                ]
                .map(String::from)
                .to_vec(),
                ddl_commits: false,
                explain: vec![ExplainMode::Estimated, ExplainMode::Actual],
                methods: [
                    methods::DDL_MODEL,
                    methods::DDL_PLAN,
                    methods::SESSIONS,
                    methods::LOCKS,
                    methods::KILL,
                    methods::DASHBOARDS,
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

    async fn explain(&self, params: ExplainParams) -> Result<Plan> {
        nexo_driver_sdk::explain::run(self, params, &plan::PostgresPlans).await
    }

    async fn ddl_model(&self, params: DdlModelParams) -> Result<DdlModel> {
        let connection = self.connection(&params.connection)?;
        ddl::model(&connection, &catalog::resolved(&params.path)).await
    }

    async fn ddl_plan(&self, params: DdlPlanParams) -> Result<DdlPlan> {
        nexo_driver_sdk::ddl::plan(&ddl::writer::PgWriter, &params)
    }

    async fn search(&self, params: SearchParams) -> Result<SearchResult> {
        let database = self.connection(&params.connection)?.database.clone();
        nexo_driver_sdk::search::run(self, params, &search::PgSearch { database }).await
    }

    async fn sessions(&self, params: AdminParams) -> Result<SessionList> {
        nexo_driver_sdk::admin::sessions(self, params, &admin::PgAdmin).await
    }

    async fn locks(&self, params: AdminParams) -> Result<LockList> {
        nexo_driver_sdk::admin::locks(self, params, &admin::PgAdmin).await
    }

    async fn kill(&self, params: KillParams) -> Result<Killed> {
        nexo_driver_sdk::admin::kill(self, params, &admin::PgAdmin).await
    }

    async fn dashboards(&self, _params: DashboardParams) -> Result<Dashboards> {
        Ok(Dashboards {
            dashboards: dashboards::predefined(),
        })
    }
}
