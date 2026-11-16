//! The session of a connection, on its own thread: it does what is asked, one thing at a
//! time. A result being read keeps its statement open until the next request: then its
//! cursor ends.
mod cursor;
mod statement;
mod transaction;

use crate::{connection::Running, errors::database, guard::Guard, values};
use nexo_driver_sdk::{
    Result, Value, limits,
    statements::{ExecuteParams, ExecuteResult, Page, TransactionAction, TransactionState},
};
use rusqlite::{Connection, Statement, params_from_iter};
use std::sync::Arc;
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

/// What a session has and remembers between requests.
pub(crate) struct Session {
    pub conn: Connection,
    pub guard: Guard,
    pub running: Arc<Running>,
    /// Every statement is its own transaction; otherwise the first one opens a transaction
    /// that waits for a commit or a rollback.
    pub auto_commit: bool,
    /// Names the cursors of this session.
    pub cursors: u64,
}

impl Session {
    pub fn state(&self) -> TransactionState {
        TransactionState {
            auto_commit: self.auto_commit,
            open: !self.conn.is_autocommit(),
        }
    }
}

/// Binds the values of a statement, in order.
pub(crate) fn bind(statement: &mut Statement<'_>, params: &[Value]) -> rusqlite::Result<()> {
    for (index, value) in params.iter().enumerate() {
        statement.raw_bind_parameter(index + 1, values::param(value))?;
    }
    Ok(())
}

/// Every row of a query, for the catalog, within the time of a statement.
fn query_rows(session: &Session, sql: &str, params: &[Value]) -> Result<Rows> {
    let guard = &session.guard;
    guard.arm(limits::STATEMENT);
    let read = || -> rusqlite::Result<Rows> {
        let mut statement = session.conn.prepare(sql)?;
        let columns = statement
            .column_names()
            .map(str::to_owned)
            .collect::<Vec<_>>();
        let count = columns.len();
        let bound = params.iter().map(values::param);
        let mut found = statement.query(params_from_iter(bound))?;
        let mut rows = Vec::new();
        while let Some(row) = found.next()? {
            let values = (0..count)
                .map(|index| row.get_ref(index).map(values::value))
                .collect::<rusqlite::Result<Vec<_>>>()?;
            rows.push(values);
        }
        Ok(Rows { columns, rows })
    };
    let outcome = read().map_err(|error| database(error, Some(sql), guard, false));
    guard.disarm();
    outcome
}

/// Serves a session until its connection is dropped.
pub(crate) fn serve(
    conn: Connection,
    guard: Guard,
    mut commands: mpsc::Receiver<Command>,
    running: Arc<Running>,
) {
    let mut session = Session {
        conn,
        guard,
        running,
        auto_commit: true,
        cursors: 0,
    };
    let mut pending: Option<Command> = None;
    loop {
        let command = match pending.take() {
            Some(command) => command,
            None => match commands.blocking_recv() {
                Some(command) => command,
                None => break,
            },
        };
        match command {
            Command::Query { sql, params, reply } => {
                let _ = reply.send(query_rows(&session, &sql, &params));
            }
            Command::Execute { params, reply } => {
                pending = statement::run(&mut session, params, reply, &mut commands);
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
                let _ = reply.send(transaction::run(&mut session, action, isolation));
            }
        }
    }
}
