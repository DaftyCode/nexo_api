use super::*;
use crate::{
    Driver, DriverError, HostLink, Result,
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
fn batch(rows: Vec<Vec<Value>>, mode: ImportMode, stop: bool) -> ImportParams {
    ImportParams {
        connection: "c".into(),
        schema: Some("shop".into()),
        table: "items".into(),
        columns: vec!["id".into(), "label".into()],
        rows,
        mode,
        key: vec!["id".into()],
        stop_on_error: stop,
        first: 11,
    }
}
fn row(id: i64, label: &str) -> Vec<Value> {
    vec![Value::Integer(id), Value::Text(label.into())]
}

#[test]
fn builds_inserts_and_upserts_for_each_dialect() {
    let postgres = dialect("postgresql", "\"", "\"", ParameterStyle::Numbered);
    let params = batch(vec![row(1, "a"), row(2, "b")], ImportMode::Upsert, false);
    assert_eq!(
        insert(&postgres, &params, 2).unwrap(),
        "INSERT INTO \"shop\".\"items\" (\"id\", \"label\") VALUES ($1, $2), ($3, $4)"
    );
    assert_eq!(
        upsert(&postgres, &params).unwrap(),
        "INSERT INTO \"shop\".\"items\" (\"id\", \"label\") VALUES ($1, $2) ON CONFLICT (\"id\") DO UPDATE SET \"label\" = EXCLUDED.\"label\""
    );
    let mysql = dialect("mysql", "`", "`", ParameterStyle::Question);
    assert_eq!(
        upsert(&mysql, &params).unwrap(),
        "INSERT INTO `shop`.`items` (`id`, `label`) VALUES (?, ?) ON DUPLICATE KEY UPDATE `label` = VALUES(`label`)"
    );
    let tsql = dialect("tsql", "[", "]", ParameterStyle::Named);
    assert_eq!(
        upsert(&tsql, &params).unwrap(),
        "MERGE INTO [shop].[items] AS t USING (SELECT @P1 AS [id], @P2 AS [label]) AS s ON t.[id] = s.[id] WHEN MATCHED THEN UPDATE SET t.[label] = s.[label] WHEN NOT MATCHED THEN INSERT ([id], [label]) VALUES (s.[id], s.[label]);"
    );
    let mut keyless = params.clone();
    keyless.key.clear();
    assert!(upsert(&postgres, &keyless).is_err());
    let mut short = params;
    short.rows[1].pop();
    assert_eq!(
        insert(&postgres, &short, 2).unwrap_err().message,
        "Row 12 has 1 values for 2 columns"
    );
}

/// Fails every statement that holds a value `"bad"`.
struct Fake {
    state: Mutex<TransactionState>,
    asked: Mutex<Vec<String>>,
}
impl Fake {
    fn new(auto_commit: bool, open: bool) -> Self {
        Self {
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
            dialect: dialect("postgresql", "\"", "\"", ParameterStyle::Numbered),
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
        let short = params.sql.split(" (").next().unwrap_or_default().to_owned();
        self.asked.lock().unwrap().push(short);
        if params.params.contains(&Value::Text("bad".into())) {
            return Err(DriverError::invalid("value too long"));
        }
        Ok(ExecuteResult {
            affected: Some(1),
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

#[tokio::test]
async fn going_on_after_failures_undoes_only_the_rows_that_fail() {
    let fake = Fake::new(true, false);
    let rows = vec![row(1, "a"), row(2, "bad"), row(3, "c")];
    let done = write(&fake, batch(rows, ImportMode::Insert, false))
        .await
        .unwrap();
    assert_eq!((done.inserted, done.failed), (2, 1));
    assert_eq!(done.failures[0].position, 12);
    assert_eq!(done.failures[0].message, "value too long");
    let asked = fake.asked();
    assert_eq!(asked[..2], ["Status", "Begin"]);
    assert!(asked.contains(&"ROLLBACK TO SAVEPOINT nexo_import_row".to_owned()));
    assert_eq!(asked.last().unwrap(), "Commit");
}

#[tokio::test]
async fn stopping_at_the_first_failure_writes_nothing() {
    let fake = Fake::new(true, false);
    let rows = vec![row(1, "a"), row(2, "bad")];
    let done = write(&fake, batch(rows, ImportMode::Insert, true))
        .await
        .unwrap();
    assert!(done.stopped);
    assert_eq!((done.inserted, done.failed), (0, 1));
    // One multi-row statement: the failure names its rows.
    assert_eq!(done.failures[0].position, 11);
    assert_eq!(done.failures[0].last, Some(12));
    assert_eq!(fake.asked().last().unwrap(), "Rollback");

    // Inside a transaction already open, only the batch is undone.
    let fake = Fake::new(false, true);
    let done = write(&fake, batch(vec![row(1, "bad")], ImportMode::Upsert, true))
        .await
        .unwrap();
    assert!(done.stopped);
    let asked = fake.asked();
    assert_eq!(asked[1], "SAVEPOINT nexo_import");
    assert_eq!(asked.last().unwrap(), "ROLLBACK TO SAVEPOINT nexo_import");
    assert!(!asked.contains(&"Commit".to_owned()));
}

#[tokio::test]
async fn upserts_are_counted_and_released_inside_an_open_transaction() {
    let fake = Fake::new(true, true);
    let done = write(
        &fake,
        batch(vec![row(1, "a"), row(2, "b")], ImportMode::Upsert, false),
    )
    .await
    .unwrap();
    assert_eq!((done.upserted, done.inserted), (2, 0));
    assert_eq!(
        fake.asked().last().unwrap(),
        "RELEASE SAVEPOINT nexo_import"
    );
}
