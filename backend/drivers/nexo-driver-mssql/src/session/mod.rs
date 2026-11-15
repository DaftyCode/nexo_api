//! The session of a connection: one task owns the TDS client and does what is asked, one
//! thing at a time, as SQL Server does on a connection. A result being read keeps its rows
//! in the server until the next request: then its cursor ends.
mod read;
mod statement;
mod transaction;

use crate::{
    connection::Opener,
    errors::{cancelled, driver_error, reopened},
    messages, values,
};
use nexo_driver_sdk::{
    DriverError, Result, Value,
    statements::{ExecuteParams, ExecuteResult, Page, TransactionAction, TransactionState},
};
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};
use tokio::sync::{mpsc, oneshot};
use tokio_util::compat::Compat;

pub(crate) type Sql = tiberius::Client<Compat<tokio::net::TcpStream>>;

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
    /// The isolation level last set, if one was.
    pub isolation: Option<String>,
    /// Names the cursors of this session.
    pub cursors: u64,
    /// Opens the connection again when a cancel leaves it out of step.
    opener: Opener,
    /// The connection is lost: the session ends.
    broken: bool,
}

/// Runs a batch and drops what it returns.
pub(crate) async fn batch(client: &mut Sql, sql: &str) -> Result<()> {
    client
        .simple_query(sql)
        .await
        .map_err(driver_error)?
        .into_results()
        .await
        .map_err(driver_error)?;
    Ok(())
}

/// Stops the request in flight with a TDS attention, and says it was cancelled.
///
/// tiberius 0.13 reads the server's acknowledgement only when it comes in the same message
/// as the end of the request; SQL Server often sends it in the next one, and then every reply
/// would come one request late. Then the session opens its connection again, on the database
/// it was using and with its settings: its temporary tables and open transaction are lost.
pub(crate) async fn interrupt(client: &mut Sql, state: &mut State) -> DriverError {
    if client.cancel_query().await.is_ok() {
        return cancelled();
    }
    let database = messages::database();
    let opened = async {
        let mut fresh = state.opener.open(database.as_deref()).await?;
        if !state.auto_commit {
            batch(&mut fresh, "SET IMPLICIT_TRANSACTIONS ON").await?;
        }
        if let Some(level) = &state.isolation {
            batch(
                &mut fresh,
                &format!("SET TRANSACTION ISOLATION LEVEL {level}"),
            )
            .await?;
        }
        Result::Ok(fresh)
    };
    match opened.await {
        Ok(fresh) => {
            *client = fresh;
            reopened()
        }
        Err(_) => {
            state.broken = true;
            cancelled()
        }
    }
}

/// A query whose values are bound, never written into the text.
pub(crate) fn bound<'a>(sql: &'a str, params: &'a [Value]) -> tiberius::Query<'a> {
    let mut query = tiberius::Query::new(sql);
    for value in params {
        match value {
            Value::Null => query.bind(Option::<String>::None),
            Value::Bool(value) => query.bind(*value),
            Value::Integer(value) => query.bind(*value),
            Value::Float(value) => query.bind(*value),
            Value::Text(text) => query.bind(text.clone()),
            Value::Typed { text, .. } => query.bind(text.clone()),
            Value::Array(_) => query.bind(serde_json::to_string(value).unwrap_or_default()),
        }
    }
    query
}

/// Reads every row of a query, for the catalog: the first result only.
async fn query_rows(client: &mut Sql, sql: &str, params: &[Value]) -> Result<Rows> {
    use futures_util::TryStreamExt;
    let mut stream = if params.is_empty() {
        client.simple_query(sql).await
    } else {
        bound(sql, params).query(client).await
    }
    .map_err(driver_error)?;
    let mut found = Rows {
        columns: Vec::new(),
        rows: Vec::new(),
    };
    let mut results = 0;
    while let Some(item) = stream.try_next().await.map_err(driver_error)? {
        match item {
            tiberius::QueryItem::Metadata(meta) => {
                results += 1;
                if results == 1 {
                    found.columns = meta.columns().iter().map(|c| c.name().to_owned()).collect();
                }
            }
            tiberius::QueryItem::Row(row) if results == 1 => found.rows.push(values::row(row)),
            tiberius::QueryItem::Row(_) => {}
        }
    }
    Ok(found)
}

/// Runs a session until its connection is dropped.
pub(crate) fn spawn(
    mut client: Sql,
    opener: Opener,
    mut commands: mpsc::Receiver<Command>,
    mut cancel: mpsc::UnboundedReceiver<String>,
    closed: Arc<AtomicBool>,
) {
    tokio::spawn(async move {
        messages::listen();
        let mut state = State {
            auto_commit: true,
            isolation: None,
            cursors: 0,
            opener,
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
                    let outcome = query_rows(&mut client, &sql, &params).await;
                    let _ = reply.send(outcome);
                }
                Command::Execute { params, reply } => {
                    pending = statement::run(
                        &mut client,
                        params,
                        reply,
                        &mut commands,
                        &mut cancel,
                        &mut state,
                    )
                    .await;
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
                    let outcome =
                        transaction::run(&mut client, &mut state, action, isolation).await;
                    let _ = reply.send(outcome);
                }
            }
            if state.broken {
                break;
            }
        }
        messages::stop();
        closed.store(true, Ordering::Relaxed);
    });
}
