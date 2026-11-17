use super::*;
use crate::{
    Driver, ErrorCode, HostLink, Result, Value, ValueKind,
    protocol::{
        Capabilities, ConnectParams, Dialect, DriverInfo, Hello, ObjectParams, ParameterStyle,
        ServerInfo, TreeNode,
    },
    statements::{
        CursorParams, ExecuteParams, ExecuteResult, FetchParams, Page, TransactionAction,
        TransactionParams, TransactionState,
    },
};
use async_trait::async_trait;
use std::sync::Mutex;

fn dialect(name: &str, open: &str, close: &str, parameters: ParameterStyle) -> Dialect {
    Dialect {
        name: name.into(),
        quote_open: open.into(),
        quote_close: close.into(),
        parameters,
        ..Dialect::default()
    }
}
fn cell(column: &str, value: Value) -> Cell {
    Cell {
        column: column.into(),
        value,
        default: false,
    }
}
fn params(changes: Vec<RowChange>, optimistic: bool) -> RowsWriteParams {
    RowsWriteParams {
        connection: "c".into(),
        schema: Some("shop".into()),
        table: "order \"items\"".into(),
        changes,
        optimistic,
    }
}

#[test]
fn builds_each_change_with_bound_values_and_quoted_names() {
    let insert = RowChange::Insert {
        values: vec![
            cell("label", Value::Text("lamp".into())),
            Cell {
                column: "created".into(),
                value: Value::Null,
                default: true,
            },
        ],
    };
    let update = RowChange::Update {
        key: vec![cell("id", Value::Integer(7))],
        values: vec![cell("total", Value::typed(ValueKind::Decimal, "9.50"))],
        original: vec![
            cell("total", Value::Null),
            cell("label", Value::Text("x".into())),
        ],
    };
    let delete = RowChange::Delete {
        key: vec![cell("id", Value::Integer(8))],
        original: Vec::new(),
    };
    let postgres = dialect("postgresql", "\"", "\"", ParameterStyle::Numbered);
    let built = statements(&postgres, &params(vec![insert, update, delete], true)).unwrap();
    assert_eq!(
        built[0].sql,
        "INSERT INTO \"shop\".\"order \"\"items\"\"\" (\"label\") VALUES ($1)"
    );
    assert_eq!(built[0].params, [Value::Text("lamp".into())]);
    // Optimistic: the original of what changed, `IS NULL` when it was NULL.
    assert_eq!(
        built[1].sql,
        "UPDATE \"shop\".\"order \"\"items\"\"\" SET \"total\" = $1 WHERE \"id\" = $2 AND \"total\" IS NULL"
    );
    assert_eq!(
        built[2].sql,
        "DELETE FROM \"shop\".\"order \"\"items\"\"\" WHERE \"id\" = $1"
    );
    assert!(built.iter().all(|statement| statement.one_row));

    let tsql = dialect("tsql", "[", "]", ParameterStyle::Named);
    let mut named = params(
        vec![RowChange::Delete {
            key: vec![cell("a]b", Value::Integer(1)), cell("c", Value::Integer(2))],
            original: Vec::new(),
        }],
        false,
    );
    named.schema = None;
    named.table = "t".into();
    assert_eq!(
        statements(&tsql, &named).unwrap()[0].sql,
        "DELETE FROM [t] WHERE [a]]b] = @P1 AND [c] = @P2"
    );
    let mysql = dialect("mysql", "`", "`", ParameterStyle::Question);
    let empty = params(vec![RowChange::Insert { values: Vec::new() }], false);
    assert_eq!(
        statements(&mysql, &empty).unwrap()[0].sql,
        "INSERT INTO `shop`.`order \"items\"` () VALUES ()"
    );
    let keyless = params(
        vec![RowChange::Delete {
            key: Vec::new(),
            original: Vec::new(),
        }],
        false,
    );
    assert!(statements(&mysql, &keyless).is_err());
}

/// A driver that runs nothing: it answers each statement with the rows it was told, and
/// keeps what it was asked.
struct Fake {
    affected: Vec<u64>,
    state: Mutex<TransactionState>,
    asked: Mutex<Vec<String>>,
}
impl Fake {
    fn new(affected: Vec<u64>, auto_commit: bool, open: bool) -> Self {
        Self {
            affected,
            state: Mutex::new(TransactionState { auto_commit, open }),
            asked: Mutex::default(),
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
            capabilities: Capabilities::default(),
            dialect: dialect("sqlite", "\"", "\"", ParameterStyle::Question),
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
        let mut asked = self.asked.lock().unwrap();
        asked.push(params.sql.clone());
        let writes = asked
            .iter()
            .filter(|sql| sql.starts_with("UPDATE") || sql.starts_with("DELETE"))
            .count();
        let affected = writes
            .checked_sub(1)
            .and_then(|at| self.affected.get(at))
            .copied();
        Ok(ExecuteResult {
            affected,
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
        match params.action {
            TransactionAction::Begin => state.open = true,
            TransactionAction::Commit | TransactionAction::Rollback => state.open = false,
            _ => {}
        }
        self.asked
            .lock()
            .unwrap()
            .push(format!("{:?}", params.action));
        Ok(*state)
    }
}

fn two_updates() -> RowsWriteParams {
    let update = |id| RowChange::Update {
        key: vec![cell("id", Value::Integer(id))],
        values: vec![cell("label", Value::Text("x".into()))],
        original: Vec::new(),
    };
    params(vec![update(1), update(2)], false)
}

#[tokio::test]
async fn writes_in_one_transaction_and_undoes_all_when_a_row_is_missing() {
    let fake = Fake::new(vec![1, 1], true, false);
    let written = write(&fake, two_updates()).await.unwrap();
    assert_eq!(written.affected, 2);
    assert_eq!(fake.asked()[..2], ["Status".to_owned(), "Begin".to_owned()]);
    assert_eq!(fake.asked().last().unwrap(), "Commit");

    // The second row was deleted by another session: nothing is saved.
    let fake = Fake::new(vec![1, 0], true, false);
    let failed = write(&fake, two_updates()).await.unwrap_err();
    assert_eq!(failed.code, ErrorCode::Invalid);
    assert!(
        failed.message.starts_with("Change 2 was not saved"),
        "{failed}"
    );
    assert_eq!(failed.detail.unwrap()["change"], 1);
    assert_eq!(fake.asked().last().unwrap(), "Rollback");
    // A key that is not unique changes several rows: nothing is saved either.
    let fake = Fake::new(vec![3], true, false);
    let failed = write(&fake, two_updates()).await.unwrap_err();
    assert!(failed.message.contains("several rows"), "{failed}");
}

#[tokio::test]
async fn inside_an_open_transaction_a_savepoint_undoes_only_the_write() {
    let fake = Fake::new(vec![1, 0], false, true);
    assert!(write(&fake, two_updates()).await.is_err());
    let asked = fake.asked();
    assert_eq!(asked[1], "SAVEPOINT nexo_rows");
    assert_eq!(asked.last().unwrap(), "ROLLBACK TO SAVEPOINT nexo_rows");
    assert!(!asked.contains(&"Rollback".to_owned()));
    // Saved, the transaction stays open for the person to commit.
    let fake = Fake::new(vec![1, 1], false, false);
    write(&fake, two_updates()).await.unwrap();
    assert!(
        !fake
            .asked()
            .iter()
            .any(|asked| asked == "Commit" || asked == "Begin")
    );
}
