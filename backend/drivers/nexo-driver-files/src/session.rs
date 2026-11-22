//! The session of a connection, on its own thread: it does what is asked, one thing at a
//! time. A result is read from the Arrow batches DuckDB streams, a page at a time, so a large
//! file is never read whole; the result stays open until the next request.
use crate::{
    connection::{Running, failed},
    guard, values,
};
use duckdb::{
    Connection,
    arrow::{datatypes::SchemaRef, record_batch::RecordBatch},
    params_from_iter,
};
use nexo_driver_sdk::{
    DriverError, Result, Value, ValueKind, limits,
    statements::{ExecuteParams, ExecuteResult, Page},
};
use std::{sync::Arc, time::Instant};
use tokio::sync::{mpsc, oneshot};

/// Rows read whole, for the catalog, with the names of their columns.
pub(crate) struct Rows {
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
}

pub(crate) fn no_cursor() -> DriverError {
    DriverError::invalid("The result is no longer open: run the statement again")
}

/// The rows of a stream of batches, one at a time.
struct Reader<I: Iterator<Item = duckdb::Result<RecordBatch>>> {
    batches: I,
    batch: Option<RecordBatch>,
    at: usize,
    kinds: Vec<ValueKind>,
}
impl<I: Iterator<Item = duckdb::Result<RecordBatch>>> Reader<I> {
    fn next(&mut self) -> Result<Option<Vec<Value>>> {
        loop {
            if let Some(batch) = &self.batch
                && self.at < batch.num_rows()
            {
                let row = (0..batch.num_columns())
                    .map(|column| values::value(batch.column(column), self.at, self.kinds[column]))
                    .collect();
                self.at += 1;
                return Ok(Some(row));
            }
            match self.batches.next() {
                Some(batch) => self.batch = Some(batch.map_err(failed)?),
                None => return Ok(None),
            }
            self.at = 0;
        }
    }
    /// Up to `count` rows, and whether the result ended.
    fn page(&mut self, count: u64) -> Result<(Vec<Vec<Value>>, bool)> {
        let mut rows = Vec::new();
        while (rows.len() as u64) < count {
            match self.next()? {
                Some(row) => rows.push(row),
                None => return Ok((rows, true)),
            }
        }
        Ok((rows, false))
    }
}

fn kinds(schema: &SchemaRef) -> Vec<ValueKind> {
    schema
        .fields()
        .iter()
        .map(|field| values::kind_of(field.data_type()).1)
        .collect()
}

/// Every row of a catalog query.
fn query_rows(conn: &Connection, sql: &str, params: &[Value]) -> Result<Rows> {
    let mut statement = conn.prepare(sql).map_err(failed)?;
    let batches = statement
        .stream_arrow(params_from_iter(params.iter().map(values::param)))
        .map_err(failed)?;
    let schema = batches.get_schema();
    let mut reader = Reader {
        batches,
        batch: None,
        at: 0,
        kinds: kinds(&schema),
    };
    let mut rows = Vec::new();
    while let Some(row) = reader.next()? {
        rows.push(row);
    }
    Ok(Rows { rows })
}

/// Serves a session until its connection is dropped.
pub(crate) fn serve(
    conn: Connection,
    files: bool,
    mut commands: mpsc::Receiver<Command>,
    running: Arc<Running>,
) {
    let mut cursors = 0_u64;
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
                let _ = reply.send(query_rows(&conn, &sql, &params));
            }
            Command::Execute { params, reply } => {
                cursors += 1;
                let cursor = format!("c{cursors}");
                pending = execute(
                    &conn,
                    files,
                    params,
                    reply,
                    &cursor,
                    &running,
                    &mut commands,
                );
            }
            Command::Fetch { reply, .. } => {
                let _ = reply.send(Err(no_cursor()));
            }
            Command::Close { reply, .. } => {
                let _ = reply.send(Err(no_cursor()));
            }
        }
    }
}

/// Runs a statement and answers its first page; then serves its other pages until it ends,
/// is closed, or another request comes, which it gives back.
fn execute(
    conn: &Connection,
    files: bool,
    params: ExecuteParams,
    reply: oneshot::Sender<Result<ExecuteResult>>,
    cursor: &str,
    running: &Running,
    commands: &mut mpsc::Receiver<Command>,
) -> Option<Command> {
    if let Err(error) = guard::check(&params.sql, files) {
        let _ = reply.send(Err(error));
        return None;
    }
    let started = Instant::now();
    running.start(&params.statement);
    let mut statement = match conn.prepare(&params.sql) {
        Ok(statement) => statement,
        Err(error) => {
            running.stop();
            let _ = reply.send(Err(failed(error)));
            return None;
        }
    };
    let bound = params_from_iter(params.params.iter().map(values::param));
    let batches = match statement.stream_arrow(bound) {
        Ok(batches) => batches,
        Err(error) => {
            running.stop();
            let _ = reply.send(Err(failed(error)));
            return None;
        }
    };
    let schema = batches.get_schema();
    let columns = values::columns(&schema);
    let mut reader = Reader {
        batches,
        batch: None,
        at: 0,
        kinds: kinds(&schema),
    };
    let page_rows = limits::page_rows(params.page_rows) as u64;
    let max_rows = params.max_rows;
    let first = max_rows.map_or(page_rows, |max| max.min(page_rows));
    let outcome = reader.page(first);
    running.stop();
    let (rows, mut ended) = match outcome {
        Ok(found) => found,
        Err(error) => {
            let _ = reply.send(Err(error));
            return None;
        }
    };
    let mut read = rows.len() as u64;
    if max_rows.is_some_and(|max| read >= max) {
        ended = true;
    }
    let _ = reply.send(Ok(ExecuteResult {
        columns,
        rows,
        cursor: (!ended).then(|| cursor.to_owned()),
        elapsed_ms: started.elapsed().as_millis() as u64,
        ..ExecuteResult::default()
    }));
    if ended {
        return None;
    }
    loop {
        let command = commands.blocking_recv()?;
        match command {
            Command::Fetch {
                cursor: wanted,
                rows: count,
                reply,
            } if wanted == cursor => {
                let count = max_rows.map_or(count, |max| max.saturating_sub(read).min(count));
                running.start(&params.statement);
                let outcome = reader.page(count);
                running.stop();
                let (rows, mut ended) = match outcome {
                    Ok(found) => found,
                    Err(error) => {
                        let _ = reply.send(Err(error));
                        return None;
                    }
                };
                read += rows.len() as u64;
                if max_rows.is_some_and(|max| read >= max) {
                    ended = true;
                }
                let _ = reply.send(Ok(Page {
                    rows,
                    cursor: (!ended).then(|| cursor.to_owned()),
                }));
                if ended {
                    return None;
                }
            }
            Command::Close {
                cursor: wanted,
                reply,
            } if wanted == cursor => {
                let _ = reply.send(Ok(()));
                return None;
            }
            // Anything else ends the result.
            other => return Some(other),
        }
    }
}
