//! What a driver implements, and its line back to the host.
use crate::{
    DriverError, Peer, Result,
    admin::{AdminParams, KillParams, Killed, LockList, SessionList},
    dashboard::{DashboardParams, Dashboards},
    ddl::{DdlModel, DdlModelParams, DdlPlan, DdlPlanParams},
    explain::{ExplainParams, Plan},
    import::{ImportParams, Imported},
    methods,
    protocol::{
        ConnectParams, Ddl, Hello, LogParams, NetResolveParams, NetResolved, ObjectDescription,
        ObjectParams, ServerInfo, TestReport, TreeNode,
    },
    rows::{RowsWriteParams, RowsWritten},
    search::{SearchParams, SearchResult},
    statements::{
        CancelParams, CursorParams, ExecuteParams, ExecuteResult, FetchParams, Page,
        TransactionAction, TransactionParams, TransactionState,
    },
};
use async_trait::async_trait;
use serde_json::{Value, json};
use std::{net::SocketAddr, time::Instant};

/// The host, as a driver sees it.
#[derive(Clone)]
pub struct HostLink {
    peer: Peer,
}
impl HostLink {
    pub(crate) fn new(peer: Peer) -> Self {
        Self { peer }
    }
    /// The addresses of `host` the driver may connect to for this connection. The host
    /// applies its egress policy and the allowed domains of the connection's secrets; a
    /// driver never resolves a name itself.
    pub async fn resolve(
        &self,
        connection: &str,
        host: &str,
        port: u16,
    ) -> Result<Vec<SocketAddr>> {
        let params = NetResolveParams {
            connection: connection.to_owned(),
            host: host.to_owned(),
            port,
        };
        let answer = self
            .peer
            .request(methods::NET_RESOLVE, json!(params))
            .await?;
        let resolved: NetResolved = serde_json::from_value(answer)
            .map_err(|error| DriverError::internal(format!("Unreadable answer: {error}")))?;
        let addresses: Vec<SocketAddr> = resolved
            .addresses
            .iter()
            .filter_map(|address| address.parse().ok())
            .collect();
        if addresses.is_empty() {
            return Err(DriverError::network(format!("{host} has no address")));
        }
        Ok(addresses)
    }
    /// Whether this connection may reach `host:port`: the host applies its egress policy
    /// (as the far side of the connection's proxy or tunnel resolves it, when it has one) and
    /// the allowed domains of the connection's secrets. For a driver whose library connects
    /// by name and can be given no address (MongoDB).
    pub async fn check(&self, connection: &str, host: &str, port: u16) -> Result<()> {
        let params = NetResolveParams {
            connection: connection.to_owned(),
            host: host.to_owned(),
            port,
        };
        self.peer.request(methods::NET_CHECK, json!(params)).await?;
        Ok(())
    }
    /// A line for the host's log. Never a secret.
    pub async fn log(&self, level: &str, message: impl Into<String>) {
        let params = LogParams {
            level: level.to_owned(),
            message: message.into(),
        };
        self.peer.notify(methods::LOG, json!(params)).await;
    }
}

fn unsupported<T>(what: &str) -> Result<T> {
    Err(DriverError::unsupported(format!(
        "This database driver does not support {what}"
    )))
}

/// A database driver. One value serves every connection of its process, so it keeps its
/// connections by the name `connect` gives them.
#[async_trait]
pub trait Driver: Send + Sync + 'static {
    fn hello(&self) -> Hello;

    async fn connect(&self, host: &HostLink, params: ConnectParams) -> Result<ServerInfo>;
    async fn disconnect(&self, connection: &str) -> Result<()>;
    /// Connects, measures a round trip and disconnects.
    async fn test(&self, host: &HostLink, params: ConnectParams) -> Result<TestReport> {
        let connection = params.connection.clone();
        let started = Instant::now();
        let server = self.connect(host, params).await?;
        let ping_ms = started.elapsed().as_millis() as u64;
        self.disconnect(&connection).await?;
        Ok(TestReport { server, ping_ms })
    }

    /// The children of a node of the tree; an empty path asks for the top ones.
    async fn tree(&self, params: ObjectParams) -> Result<Vec<TreeNode>>;
    async fn describe(&self, _params: ObjectParams) -> Result<ObjectDescription> {
        unsupported("describing objects")
    }
    async fn ddl(&self, _params: ObjectParams) -> Result<Ddl> {
        unsupported("the DDL of objects")
    }

    async fn execute(&self, params: ExecuteParams) -> Result<ExecuteResult>;
    async fn fetch(&self, params: FetchParams) -> Result<Page>;
    async fn close(&self, params: CursorParams) -> Result<()>;
    async fn cancel(&self, _params: CancelParams) -> Result<()> {
        unsupported("cancelling a statement")
    }
    /// A driver without transactions (Cassandra, Elasticsearch, Drill, Hive) commits every
    /// statement: its state says so, also when a production connection asks for manual
    /// commits, and only what needs a transaction is refused.
    async fn transaction(&self, params: TransactionParams) -> Result<TransactionState> {
        match params.action {
            TransactionAction::Status | TransactionAction::Auto | TransactionAction::Manual => {
                Ok(TransactionState {
                    auto_commit: true,
                    open: false,
                })
            }
            TransactionAction::Begin | TransactionAction::Commit | TransactionAction::Rollback => {
                unsupported("transactions")
            }
        }
    }
    /// Writes rows changed in the data grid as one, with the driver's own `execute` and
    /// `transaction` (see [`crate::rows`]); a driver may write them its own way.
    async fn rows_write(&self, params: RowsWriteParams) -> Result<RowsWritten> {
        crate::rows::write(self, params).await
    }
    /// Imports a batch of rows into a table, with the driver's own `execute` and
    /// `transaction` (see [`crate::import`]).
    async fn import(&self, params: ImportParams) -> Result<Imported> {
        crate::import::write(self, params).await
    }
    /// The model of a table, and the types its engine offers (structure editor).
    async fn ddl_model(&self, _params: DdlModelParams) -> Result<DdlModel> {
        unsupported("editing the structure of tables")
    }
    /// The statements that change a table into another, with [`crate::ddl::plan`] and the
    /// engine's [`crate::ddl::DdlWriter`]; nothing runs.
    async fn ddl_plan(&self, _params: DdlPlanParams) -> Result<DdlPlan> {
        unsupported("editing the structure of tables")
    }
    /// Searches objects or data; a driver answers it with [`crate::search::run`] and its
    /// engine's [`crate::search::SearchCatalog`].
    async fn search(&self, _params: SearchParams) -> Result<SearchResult> {
        unsupported("searching")
    }
    /// The plan of a statement; a driver answers it with [`crate::explain::run`] and its
    /// engine's [`crate::explain::PlanReader`], and lists the modes in its capabilities.
    async fn explain(&self, _params: ExplainParams) -> Result<Plan> {
        unsupported("execution plans")
    }

    /// The sessions of the server; a driver answers it with [`crate::admin::sessions`] and
    /// its engine's [`crate::admin::AdminCatalog`].
    async fn sessions(&self, _params: AdminParams) -> Result<SessionList> {
        unsupported("listing the sessions of the server")
    }
    /// Who waits for whom ([`crate::admin::locks`]).
    async fn locks(&self, _params: AdminParams) -> Result<LockList> {
        unsupported("listing locks")
    }
    /// Cancels the statement of a session or ends it ([`crate::admin::kill`]).
    async fn kill(&self, _params: KillParams) -> Result<Killed> {
        unsupported("ending sessions")
    }

    /// The panels of the server's dashboard ([`crate::dashboard`]).
    async fn dashboards(&self, _params: DashboardParams) -> Result<Dashboards> {
        unsupported("dashboards")
    }

    /// Any other method: the optional ones a driver lists in its capabilities and the
    /// extensions of engines that are not relational.
    async fn extension(&self, _host: &HostLink, method: &str, _params: Value) -> Result<Value> {
        unsupported(method)
    }
}
