use super::*;
use crate::{
    Column, Driver, DriverError, HostLink, ValueKind,
    protocol::{ConnectParams, Dialect, DriverInfo, Hello, ObjectParams, ServerInfo, TreeNode},
    statements::{
        CursorParams, ExecuteParams, FetchParams, Page, TransactionAction, TransactionParams,
        TransactionState,
    },
};
use async_trait::async_trait;
use std::sync::Mutex;

/// A driver that keeps what it was asked and answers the plan statement with one row.
struct Fake {
    dialect: &'static str,
    state: Mutex<TransactionState>,
    asked: Mutex<Vec<String>>,
    fails: bool,
    plan: Value,
}
impl Fake {
    fn new(dialect: &'static str, open: bool) -> Self {
        Self {
            dialect,
            state: Mutex::new(TransactionState {
                auto_commit: !open,
                open,
            }),
            asked: Mutex::new(Vec::new()),
            fails: false,
            plan: Value::Text("Seq Scan on t".into()),
        }
    }
    fn asked(&self) -> Vec<String> {
        self.asked.lock().unwrap().clone()
    }
}

#[async_trait]
impl Driver for Fake {
    fn hello(&self) -> Hello {
        Hello {
            protocol: 1,
            driver: DriverInfo {
                id: "fake".into(),
                name: "Fake".into(),
                version: "1".into(),
            },
            capabilities: Default::default(),
            dialect: Dialect {
                name: self.dialect.into(),
                ..Dialect::default()
            },
        }
    }
    async fn connect(&self, _: &HostLink, _: ConnectParams) -> Result<ServerInfo> {
        Ok(ServerInfo::default())
    }
    async fn disconnect(&self, _: &str) -> Result<()> {
        Ok(())
    }
    async fn tree(&self, _: ObjectParams) -> Result<Vec<TreeNode>> {
        Ok(Vec::new())
    }
    async fn execute(&self, params: ExecuteParams) -> Result<ExecuteResult> {
        self.asked.lock().unwrap().push(params.sql.clone());
        if !params.sql.starts_with("PLAN ") {
            return Ok(ExecuteResult::default());
        }
        if self.fails {
            return Err(DriverError::invalid("syntax error"));
        }
        Ok(ExecuteResult {
            columns: vec![Column::new("QUERY PLAN", "text", ValueKind::Text)],
            rows: vec![vec![self.plan.clone()]],
            ..ExecuteResult::default()
        })
    }
    async fn fetch(&self, _: FetchParams) -> Result<Page> {
        Ok(Page::default())
    }
    async fn close(&self, _: CursorParams) -> Result<()> {
        Ok(())
    }
    async fn transaction(&self, params: TransactionParams) -> Result<TransactionState> {
        let mut state = self.state.lock().unwrap();
        let name = match params.action {
            TransactionAction::Begin => {
                state.open = true;
                "BEGIN"
            }
            TransactionAction::Rollback => {
                state.open = false;
                "ROLLBACK"
            }
            _ => "STATUS",
        };
        self.asked.lock().unwrap().push(name.into());
        Ok(*state)
    }
}

/// Plans with `PLAN <sql>`, between a setting on and off.
struct Reader;
impl PlanReader for Reader {
    fn steps(&self, params: &ExplainParams) -> Result<Steps> {
        Ok(Steps {
            before: vec![format!("SET PLAN {:?} ON", params.mode)],
            plan: format!("PLAN {}", params.sql),
            params: None,
            after: vec!["SET PLAN OFF".into()],
        })
    }
    fn read(&self, answer: &ExecuteResult, _: ExplainMode) -> Result<PlanRead> {
        let original = text_of(&answer.columns, &answer.rows, Some("query plan"));
        Ok(PlanRead {
            nodes: vec![PlanNode {
                operation: original.clone(),
                ..PlanNode::default()
            }],
            format: "text",
            original,
            total_ms: None,
        })
    }
}

fn params(mode: ExplainMode, writes: bool) -> ExplainParams {
    ExplainParams {
        connection: "c".into(),
        statement: "run-1".into(),
        sql: "UPDATE t SET a = 1".into(),
        params: Vec::new(),
        mode,
        writes,
    }
}

#[tokio::test]
async fn an_estimated_plan_runs_its_steps_and_no_transaction() {
    let fake = Fake::new("postgresql", false);
    let plan = run(&fake, params(ExplainMode::Estimated, true), &Reader)
        .await
        .unwrap();
    assert_eq!(
        fake.asked(),
        [
            "SET PLAN Estimated ON",
            "PLAN UPDATE t SET a = 1",
            "SET PLAN OFF"
        ]
    );
    assert_eq!(plan.nodes[0].operation, "Seq Scan on t");
    assert_eq!(plan.format, "text");
    assert!(!plan.rolled_back);
}

#[tokio::test]
async fn the_actual_plan_of_a_write_is_always_rolled_back() {
    let fake = Fake::new("postgresql", false);
    let plan = run(&fake, params(ExplainMode::Actual, true), &Reader)
        .await
        .unwrap();
    assert_eq!(
        fake.asked(),
        [
            "STATUS",
            "BEGIN",
            "SET PLAN Actual ON",
            "PLAN UPDATE t SET a = 1",
            "SET PLAN OFF",
            "ROLLBACK"
        ]
    );
    assert!(plan.rolled_back);

    // Inside a transaction already open, only up to a savepoint (SQL Server's own words).
    let fake = Fake::new("tsql", true);
    run(&fake, params(ExplainMode::Actual, true), &Reader)
        .await
        .unwrap();
    let asked = fake.asked();
    assert_eq!(asked[1], "SAVE TRANSACTION nexo_explain");
    assert_eq!(asked.last().unwrap(), "ROLLBACK TRANSACTION nexo_explain");
    let fake = Fake::new("postgresql", true);
    run(&fake, params(ExplainMode::Actual, true), &Reader)
        .await
        .unwrap();
    assert_eq!(
        fake.asked().last().unwrap(),
        "ROLLBACK TO SAVEPOINT nexo_explain"
    );
}

#[tokio::test]
async fn a_failed_plan_still_undoes_its_settings_and_the_write() {
    let mut fake = Fake::new("postgresql", false);
    fake.fails = true;
    let error = run(&fake, params(ExplainMode::Actual, true), &Reader)
        .await
        .unwrap_err();
    assert_eq!(error.message, "syntax error");
    let asked = fake.asked();
    assert_eq!(&asked[asked.len() - 2..], ["SET PLAN OFF", "ROLLBACK"]);
}

#[tokio::test]
async fn a_plan_longer_than_a_value_is_refused() {
    let mut fake = Fake::new("postgresql", false);
    fake.plan = Value::Typed {
        kind: ValueKind::Text,
        text: "{".into(),
        full_size: Some(5_000_000),
    };
    let error = run(&fake, params(ExplainMode::Estimated, false), &Reader)
        .await
        .unwrap_err();
    assert!(error.message.contains("longer than a value"));
}

#[test]
fn plans_travel_in_camel_case_without_empty_fields() {
    let plan = Plan {
        mode: ExplainMode::Actual,
        nodes: vec![PlanNode {
            operation: "Seq Scan".into(),
            object: Some("orders".into()),
            estimated_rows: Some(10.0),
            actual_ms: Some(0.5),
            flags: vec![flags::FULL_SCAN.into()],
            ..PlanNode::default()
        }],
        format: "json".into(),
        original: "[]".into(),
        total_ms: Some(1.0),
        rolled_back: false,
    };
    let json = serde_json::to_value(&plan).unwrap();
    assert_eq!(
        json,
        serde_json::json!({
            "mode": "actual",
            "nodes": [{
                "operation": "Seq Scan",
                "object": "orders",
                "estimatedRows": 10.0,
                "actualMs": 0.5,
                "flags": ["full-scan"]
            }],
            "format": "json",
            "original": "[]",
            "totalMs": 1.0
        })
    );
    assert_eq!(serde_json::from_value::<Plan>(json).unwrap(), plan);
    assert_eq!(number(&serde_json::json!("12.5")), Some(12.5));
    assert_eq!(number(&serde_json::json!(3)), Some(3.0));
}
