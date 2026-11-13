//! The protocol from the host's side: each method with its types.
use crate::{
    DriverError, Peer, Result, methods,
    protocol::{
        ConnectParams, ConnectionParams, Ddl, Hello, ObjectDescription, ObjectParams, ServerInfo,
        TestReport, TreeNode, TreeNodes,
    },
    statements::{
        CancelParams, CursorParams, ExecuteParams, ExecuteResult, FetchParams, Page,
        TransactionParams, TransactionState,
    },
};
use serde::{Serialize, de::DeserializeOwned};
use serde_json::Value;

#[derive(Clone)]
pub struct Client {
    peer: Peer,
}
impl Client {
    pub fn new(peer: Peer) -> Self {
        Self { peer }
    }
    pub fn peer(&self) -> &Peer {
        &self.peer
    }
    /// Asks any method, also the ones this version does not name.
    pub async fn call<P, R>(&self, method: &str, params: &P) -> Result<R>
    where
        P: Serialize + ?Sized,
        R: DeserializeOwned,
    {
        let params = serde_json::to_value(params)
            .map_err(|error| DriverError::invalid(format!("Unwritable request: {error}")))?;
        let answer = self.peer.request(method, params).await?;
        serde_json::from_value(answer).map_err(|error| {
            DriverError::internal(format!(
                "The driver answered {method} with something else: {error}"
            ))
        })
    }
    pub async fn hello(&self) -> Result<Hello> {
        self.call(methods::HELLO, &Value::Null).await
    }
    pub async fn connect(&self, params: &ConnectParams) -> Result<ServerInfo> {
        self.call(methods::CONNECT, params).await
    }
    pub async fn test(&self, params: &ConnectParams) -> Result<TestReport> {
        self.call(methods::TEST, params).await
    }
    pub async fn disconnect(&self, connection: &str) -> Result<()> {
        let params = ConnectionParams {
            connection: connection.to_owned(),
        };
        self.call(methods::DISCONNECT, &params).await
    }
    pub async fn tree(&self, params: &ObjectParams) -> Result<Vec<TreeNode>> {
        let nodes: TreeNodes = self.call(methods::TREE, params).await?;
        Ok(nodes.nodes)
    }
    pub async fn describe(&self, params: &ObjectParams) -> Result<ObjectDescription> {
        self.call(methods::DESCRIBE, params).await
    }
    pub async fn ddl(&self, params: &ObjectParams) -> Result<Ddl> {
        self.call(methods::DDL, params).await
    }
    pub async fn execute(&self, params: &ExecuteParams) -> Result<ExecuteResult> {
        self.call(methods::EXECUTE, params).await
    }
    pub async fn fetch(&self, params: &FetchParams) -> Result<Page> {
        self.call(methods::FETCH, params).await
    }
    pub async fn close(&self, params: &CursorParams) -> Result<()> {
        self.call(methods::CLOSE, params).await
    }
    pub async fn cancel(&self, params: &CancelParams) -> Result<()> {
        self.call(methods::CANCEL, params).await
    }
    pub async fn transaction(&self, params: &TransactionParams) -> Result<TransactionState> {
        self.call(methods::TRANSACTION, params).await
    }
}
