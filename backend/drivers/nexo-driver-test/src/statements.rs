//! The statements of the test driver:
//!
//! - `select numbers <n>`: `n` rows, by pages;
//! - `select people` and `count people`; `insert person <name>`;
//! - `select value <big|decimal|bytes|null|text>`: one value of that kind;
//! - `select pid`: the process of the driver;
//! - `echo`: one row with the parameters of the statement;
//! - `sleep <milliseconds>`: waits, unless it is cancelled;
//! - `stderr <text>`: writes a line to the standard error;
//! - `fail`: an error of the driver; `crash`: the process ends at once;
//! - anything else is a syntax error.
use crate::{Session, TestDriver};
use nexo_driver_sdk::{
    Column, DriverError, Result, Value, ValueKind, limits,
    statements::{ExecuteParams, ExecuteResult, Page},
};
use std::{sync::Arc, time::Duration};
use tokio::sync::Notify;

/// What is left of `select numbers`: the next number and the last one.
pub(crate) struct Cursor {
    next: u64,
    last: u64,
}

fn numbers(cursor: &mut Cursor, page_rows: Option<u32>) -> Vec<Vec<Value>> {
    let end = (cursor.next + limits::page_rows(page_rows) as u64).min(cursor.last + 1);
    let rows = (cursor.next..end)
        .map(|n| vec![Value::Integer(n as i64), Value::Text(format!("row {n}"))])
        .collect();
    cursor.next = end;
    rows
}

pub(crate) fn fetch(session: &mut Session, name: &str, page_rows: Option<u32>) -> Result<Page> {
    let cursor = session
        .cursors
        .get_mut(name)
        .ok_or_else(|| DriverError::invalid("The cursor is not open"))?;
    let rows = numbers(cursor, page_rows);
    let finished = cursor.next > cursor.last;
    if finished {
        session.cursors.remove(name);
    }
    Ok(Page {
        rows,
        cursor: (!finished).then(|| name.to_owned()),
    })
}

fn one(column: Column, value: Value) -> ExecuteResult {
    ExecuteResult {
        columns: vec![column],
        rows: vec![vec![value]],
        ..ExecuteResult::default()
    }
}
fn text(name: &str) -> Column {
    Column::new(name, "text", ValueKind::Text)
}

fn value(kind: &str) -> Result<ExecuteResult> {
    let (column, value) = match kind {
        "big" => (
            Column::new("value", "bigint", ValueKind::Integer),
            Value::Integer(i64::MAX),
        ),
        "decimal" => (
            Column::new("value", "numeric", ValueKind::Decimal),
            Value::typed(ValueKind::Decimal, "12345678901234567890.5"),
        ),
        "bytes" => (
            Column::new("value", "bytea", ValueKind::Binary),
            Value::bytes(&[0, 1, 254, 255]),
        ),
        "null" => (text("value"), Value::Null),
        "text" => (text("value"), Value::Text("año".into())),
        other => return Err(DriverError::syntax(format!("There is no value {other}"))),
    };
    Ok(one(column, value))
}

/// Waits `milliseconds`, or until the statement is cancelled.
async fn sleep(driver: &TestDriver, params: &ExecuteParams, milliseconds: u64) -> Result<()> {
    let key = (params.connection.clone(), params.statement.clone());
    let cancelled = Arc::new(Notify::new());
    driver
        .running
        .lock()
        .unwrap()
        .insert(key.clone(), cancelled.clone());
    let outcome = tokio::select! {
        () = tokio::time::sleep(Duration::from_millis(milliseconds)) => Ok(()),
        () = cancelled.notified() => Err(DriverError::cancelled("The statement was cancelled")),
    };
    driver.running.lock().unwrap().remove(&key);
    outcome
}

pub(crate) async fn execute(driver: &TestDriver, params: ExecuteParams) -> Result<ExecuteResult> {
    driver.session(&params.connection, |_| Ok(()))?;
    let words: Vec<&str> = params.sql.split_whitespace().collect();
    match words.as_slice() {
        ["sleep", milliseconds] => {
            let milliseconds = milliseconds
                .parse()
                .map_err(|_| DriverError::syntax("Not a number"))?;
            sleep(driver, &params, milliseconds).await?;
            Ok(ExecuteResult::default())
        }
        ["crash"] => std::process::exit(3),
        ["fail"] => Err(DriverError::internal("The statement failed")),
        ["stderr", line @ ..] => {
            eprintln!("{}", line.join(" "));
            Ok(ExecuteResult::default())
        }
        ["echo"] => Ok(ExecuteResult {
            columns: (1..=params.params.len())
                .map(|n| Column::new(format!("p{n}"), "any", ValueKind::Other))
                .collect(),
            rows: vec![params.params.clone()],
            ..ExecuteResult::default()
        }),
        ["select", "value", kind] => value(kind),
        ["select", "pid"] => Ok(one(
            Column::new("pid", "integer", ValueKind::Integer),
            Value::Integer(i64::from(std::process::id())),
        )),
        _ => driver.session(&params.connection, |session| {
            table(session, &params, &words)
        }),
    }
}

/// The statements that read or write the tables of a connection.
fn table(session: &mut Session, params: &ExecuteParams, words: &[&str]) -> Result<ExecuteResult> {
    match words {
        ["select", "numbers", count] => {
            let last = count
                .parse()
                .map_err(|_| DriverError::syntax("Not a number"))?;
            let mut cursor = Cursor { next: 1, last };
            let rows = numbers(&mut cursor, params.page_rows);
            let name = (cursor.next <= cursor.last).then(|| {
                session.opened += 1;
                format!("cursor-{}", session.opened)
            });
            if let Some(name) = &name {
                session.cursors.insert(name.clone(), cursor);
            }
            Ok(ExecuteResult {
                columns: vec![
                    Column::new("n", "integer", ValueKind::Integer),
                    text("label"),
                ],
                rows,
                cursor: name,
                ..ExecuteResult::default()
            })
        }
        ["select", "people"] => Ok(ExecuteResult {
            columns: vec![text("name")],
            rows: session
                .people
                .iter()
                .map(|name| vec![Value::Text(name.clone())])
                .collect(),
            ..ExecuteResult::default()
        }),
        ["count", "people"] => Ok(one(
            Column::new("count", "integer", ValueKind::Integer),
            Value::Integer(session.people.len() as i64),
        )),
        ["insert", "person", name @ ..] if !name.is_empty() => {
            // In manual mode a write opens the transaction a rollback goes back from.
            if session.manual {
                session.before.get_or_insert_with(|| session.people.clone());
            }
            session.people.push(name.join(" "));
            Ok(ExecuteResult {
                affected: Some(1),
                ..ExecuteResult::default()
            })
        }
        _ => Err(
            DriverError::syntax(format!("Unknown statement: {}", params.sql))
                .with_detail(serde_json::json!({"position": 1})),
        ),
    }
}
