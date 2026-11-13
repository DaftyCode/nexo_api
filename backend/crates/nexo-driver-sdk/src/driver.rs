//! What a driver implements, and its line back to the host.
use crate::{
    DriverError, Peer, Result, methods,
    protocol::{
        ConnectParams, Ddl, Hello, LogParams, NetResolveParams, NetResolved, ObjectDescription,
        ObjectParams, ServerInfo, TestReport, TreeNode,
    },
    statements::{
        CancelParams, CursorParams, ExecuteParams, ExecuteResult, FetchParams, Page,
        TransactionParams, TransactionState,
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
    async fn transaction(&self, _params: TransactionParams) -> Result<TransactionState> {
        unsupported("transactions")
    }

    /// Any other method: the optional ones a driver lists in its capabilities and the
    /// extensions of engines that are not relational.
    async fn extension(&self, _host: &HostLink, method: &str, _params: Value) -> Result<Value> {
        unsupported(method)
    }
}
