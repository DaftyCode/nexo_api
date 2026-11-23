//! What a driver without transactions answers: it commits every statement.
use crate::{
    Driver, ErrorCode, HostLink, PROTOCOL_VERSION, Result,
    protocol::{
        Capabilities, ConnectParams, Dialect, DriverInfo, Hello, ObjectParams, ServerInfo, TreeNode,
    },
    statements::{
        CursorParams, ExecuteParams, ExecuteResult, FetchParams, Page, TransactionAction,
        TransactionParams, TransactionState,
    },
};
use async_trait::async_trait;

/// A driver of an engine without transactions, as Cassandra's or Hive's.
struct NoTransactions;
#[async_trait]
impl Driver for NoTransactions {
    fn hello(&self) -> Hello {
        Hello {
            protocol: PROTOCOL_VERSION,
            driver: DriverInfo {
                id: "none".into(),
                name: "None".into(),
                version: "1".into(),
            },
            capabilities: Capabilities::default(),
            dialect: Dialect::default(),
        }
    }
    async fn connect(&self, _host: &HostLink, _params: ConnectParams) -> Result<ServerInfo> {
        Ok(ServerInfo::default())
    }
    async fn disconnect(&self, _connection: &str) -> Result<()> {
        Ok(())
    }
    async fn tree(&self, _params: ObjectParams) -> Result<Vec<TreeNode>> {
        Ok(Vec::new())
    }
    async fn execute(&self, _params: ExecuteParams) -> Result<ExecuteResult> {
        Ok(ExecuteResult::default())
    }
    async fn fetch(&self, _params: FetchParams) -> Result<Page> {
        Ok(Page::default())
    }
    async fn close(&self, _params: CursorParams) -> Result<()> {
        Ok(())
    }
}

#[tokio::test]
async fn a_driver_without_transactions_commits_every_statement() {
    let ask = |action| TransactionParams {
        connection: "c".into(),
        action,
        isolation: None,
    };
    let committed = TransactionState {
        auto_commit: true,
        open: false,
    };
    // A SQL tab opens with the state, also when a production connection asks for manual
    // commits: the engine has none, so every statement is committed.
    for action in [
        TransactionAction::Status,
        TransactionAction::Auto,
        TransactionAction::Manual,
    ] {
        assert_eq!(
            NoTransactions.transaction(ask(action)).await.unwrap(),
            committed
        );
    }
    for action in [
        TransactionAction::Begin,
        TransactionAction::Commit,
        TransactionAction::Rollback,
    ] {
        let refused = NoTransactions.transaction(ask(action)).await.unwrap_err();
        assert_eq!(refused.code, ErrorCode::Unsupported);
    }
}
