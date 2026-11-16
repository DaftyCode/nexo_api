//! The session of a connection: one task owns the MySQL connection and does what is asked,
//! one thing at a time, as the server does on a connection. A result being read keeps its
//! rows in the server until the next request: then its cursor ends.
mod read;
mod statement;
mod transaction;

use crate::{errors::database, values};
use mysql_async::{
    Column, Conn, Params, QueryResult, Row, Value as MyValue,
    prelude::{Protocol, Queryable},
};
use nexo_driver_sdk::{
    ErrorCode, Result, Value, ValueKind,
    statements::{ExecuteParams, ExecuteResult, Page, TransactionAction, TransactionState},
};
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};
use tokio::sync::{mpsc, oneshot};

/// Rows read whole, for the catalog, with the names of their columns.
pub(crate) struct Rows {
    pub columns: Vec<String>,
    pub rows: Vec<Vec<Value>>,
}

pub(crate) enum Command {
    Query {
        sql: String,
        params: Vec<Value>,
        reply: oneshot::Sender<Result<Rows>>,
    },
    Execute {
        params: ExecuteParams,
        reply: oneshot::Sender<Result<ExecuteResult>>,
    },
    Fetch {
        cursor: String,
        rows: u64,
        reply: oneshot::Sender<Result<Page>>,
    },
    Close {
        cursor: String,
        reply: oneshot::Sender<Result<()>>,
    },
    Transaction {
        action: TransactionAction,
        isolation: Option<String>,
        reply: oneshot::Sender<Result<TransactionState>>,
    },
}

/// What a session remembers between requests.
pub(crate) struct State {
    pub auto_commit: bool,
    /// A transaction is open: begun by hand, or by a statement in manual mode.
    pub open: bool,
    /// Names the cursors of this session.
    pub cursors: u64,
    /// The server closed the connection: the session ends.
    pub broken: bool,
}

impl State {
    /// Notes an outcome: one that says the connection is gone ends the session.
    pub fn note<T>(&mut self, outcome: &Result<T>) {
        if matches!(outcome, Err(error) if error.code == ErrorCode::Closed) {
            self.broken = true;
        }
    }
}

/// A value bound to a statement, as MySQL takes it.
pub(crate) fn param(value: &Value) -> MyValue {
    match value {
        Value::Null => MyValue::NULL,
        Value::Bool(value) => MyValue::Int(i64::from(*value)),
        Value::Integer(value) => MyValue::Int(*value),
        Value::Float(value) => MyValue::Double(*value),
        Value::Text(text) => MyValue::Bytes(text.clone().into_bytes()),
        Value::Typed {
            kind: ValueKind::Binary,
            ..
        } => MyValue::Bytes(value.as_bytes().unwrap_or_default()),
        Value::Typed { text, .. } => MyValue::Bytes(text.clone().into_bytes()),
        Value::Array(_) => MyValue::Bytes(serde_json::to_vec(value).unwrap_or_default()),
    }
}

/// The parameters of a statement: none, or its values in order.
pub(crate) fn params(values: &[Value]) -> Params {
    if values.is_empty() {
        Params::Empty
    } else {
        Params::Positional(values.iter().map(param).collect())
    }
}

/// The columns and rows of the first result, and the rest of the reply read and dropped.
async fn first_result<P: Protocol>(
    mut result: QueryResult<'_, '_, P>,
) -> std::result::Result<(Arc<[Column]>, Vec<Row>), mysql_async::Error> {
    let columns = result
        .columns()
        .unwrap_or_else(|| Arc::from(Vec::<Column>::new()));
    let mut rows = Vec::new();
    while let Some(row) = result.next().await? {
        rows.push(row);
    }
    result.drop_result().await?;
    Ok((columns, rows))
}

/// Reads every row of a query, for the catalog: the first result only.
async fn query_rows(conn: &mut Conn, sql: &str, bound: &[Value]) -> Result<Rows> {
    let failed = |error| database(error, Some(sql));
    let (columns, rows) = if bound.is_empty() {
        first_result(conn.query_iter(sql).await.map_err(failed)?).await
    } else {
        first_result(conn.exec_iter(sql, params(bound)).await.map_err(failed)?).await
    }
    .map_err(failed)?;
    Ok(Rows {
        columns: columns.iter().map(|c| c.name_str().into_owned()).collect(),
        rows: rows
            .into_iter()
            .map(|row| values::row(row, &columns))
            .collect(),
    })
}

/// Runs a session until its connection is dropped or lost.
pub(crate) fn spawn(
    mut conn: Conn,
    mut commands: mpsc::Receiver<Command>,
    closed: Arc<AtomicBool>,
) {
    tokio::spawn(async move {
        let mut state = State {
            auto_commit: true,
            open: false,
            cursors: 0,
            broken: false,
        };
        let mut pending: Option<Command> = None;
        loop {
            let command = match pending.take() {
                Some(command) => command,
                None => match commands.recv().await {
                    Some(command) => command,
                    None => break,
                },
            };
            match command {
                Command::Query { sql, params, reply } => {
                    let outcome = query_rows(&mut conn, &sql, &params).await;
                    state.note(&outcome);
                    let _ = reply.send(outcome);
                }
                Command::Execute { params, reply } => {
                    pending =
                        statement::run(&mut conn, params, reply, &mut commands, &mut state).await;
                }
                Command::Fetch { reply, .. } => {
                    let _ = reply.send(Err(crate::errors::no_cursor()));
                }
                Command::Close { reply, .. } => {
                    let _ = reply.send(Err(crate::errors::no_cursor()));
                }
                Command::Transaction {
                    action,
                    isolation,
                    reply,
                } => {
                    let outcome = transaction::run(&mut conn, &mut state, action, isolation).await;
                    state.note(&outcome);
                    let _ = reply.send(outcome);
                }
            }
            if state.broken {
                break;
            }
        }
        let _ = conn.disconnect().await;
        closed.store(true, Ordering::Relaxed);
    });
}
