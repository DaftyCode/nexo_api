//! Running a statement: a write that counts its rows, or a batch whose results are read as
//! they come (the first one by pages, the next ones whole), cancelled by a TDS attention.
use super::{
    Command, Sql, State, bound, interrupt,
    read::{Interrupt, Read, Wait, or_cancel, read_first},
};
use crate::{errors::driver_error, messages, values};
use futures_util::TryStreamExt;
use nexo_driver_sdk::{
    Result, Value, limits,
    statements::{ExecuteParams, ExecuteResult, Notice, Page},
};
use std::time::Instant;
use tiberius::QueryItem;
use tokio::sync::{mpsc, oneshot};

/// The first word of a statement, after comments and spaces.
fn first_word(sql: &str) -> String {
    let mut rest = sql.trim_start();
    loop {
        if let Some(after) = rest.strip_prefix("--") {
            rest = after
                .split_once('\n')
                .map_or("", |(_, next)| next)
                .trim_start();
        } else if let Some(after) = rest.strip_prefix("/*") {
            rest = after
                .split_once("*/")
                .map_or("", |(_, next)| next)
                .trim_start();
        } else {
            break;
        }
    }
    rest.chars()
        .take_while(|c| c.is_ascii_alphabetic())
        .collect::<String>()
        .to_ascii_uppercase()
}

/// A write that returns no rows: SQL Server then says how many it changed.
/// Opens a batch the driver reads as results even when it changes rows: the measured plan of
/// a change comes back as a result.
pub(crate) const RESULTS: &str = "/* nexo:results */";

fn counts_rows(sql: &str) -> bool {
    if sql.trim_start().starts_with(RESULTS) {
        return false;
    }
    let word = first_word(sql);
    let output = sql
        .to_ascii_uppercase()
        .split(|c: char| !c.is_ascii_alphanumeric() && c != '_')
        .any(|token| token == "OUTPUT");
    matches!(word.as_str(), "INSERT" | "UPDATE" | "DELETE" | "MERGE") && !output
}

fn notices() -> Vec<Notice> {
    messages::take()
        .into_iter()
        .map(|message| Notice {
            severity: "info".into(),
            message,
        })
        .collect()
}

/// Runs a statement and answers `reply`. A result with more rows than its first page stays
/// open as a cursor until it is read, closed, or another request comes: that request is
/// returned, for the session to do next.
pub(super) async fn run(
    client: &mut Sql,
    params: ExecuteParams,
    reply: oneshot::Sender<Result<ExecuteResult>>,
    commands: &mut mpsc::Receiver<Command>,
    cancel: &mut mpsc::UnboundedReceiver<String>,
    state: &mut State,
) -> Option<Command> {
    while cancel.try_recv().is_ok() {}
    let _ = messages::take();
    let started = Instant::now();
    let name = params.statement.clone();
    let sql = params.sql.clone();
    let values = params.params.clone();
    if counts_rows(&sql) {
        let writing = async {
            if values.is_empty() {
                client.execute(sql.as_str(), &[]).await
            } else {
                bound(&sql, &values).execute(client).await
            }
        };
        let outcome = match or_cancel(writing, cancel, &name).await {
            Wait::Done(Ok(done)) => Ok(ExecuteResult {
                affected: Some(done.total()),
                notices: notices(),
                elapsed_ms: started.elapsed().as_millis() as u64,
                ..ExecuteResult::default()
            }),
            Wait::Done(Err(error)) => Err(driver_error(error)),
            Wait::Cancelled => Err(interrupt(client, state).await),
        };
        let _ = reply.send(outcome);
        return None;
    }
    let connection = &mut *client;
    let (text, bindings) = (&sql, &values);
    let opening = async move {
        if bindings.is_empty() {
            connection.simple_query(text.as_str()).await
        } else {
            bound(text, bindings).query(connection).await
        }
    };
    let opened = match or_cancel(opening, cancel, &name).await {
        Wait::Done(Ok(stream)) => Some(stream),
        Wait::Done(Err(error)) => {
            let _ = reply.send(Err(driver_error(error)));
            return None;
        }
        Wait::Cancelled => None,
    };
    if opened.is_none() {
        // Nothing holds the client any more: the attention can go.
        drop(opened);
        let _ = reply.send(Err(interrupt(client, state).await));
        return None;
    }
    // Consumed whole (a pattern would leave it to be dropped at the end, holding the client).
    let mut stream = opened.expect("a stream when not cancelled");
    let page = limits::page_rows(params.page_rows) as u64;
    let first_page = params.max_rows.map_or(page, |max| max.min(page));
    let read_first = read_first(&mut stream, cancel, &name, first_page).await;
    let Read {
        first,
        further,
        mut pending,
    } = match read_first {
        Ok(read) => read,
        Err(Interrupt::Failed(error)) => {
            let _ = reply.send(Err(driver_error(error)));
            return None;
        }
        Err(Interrupt::Cancelled) => {
            // The stream holds the client: it goes first, then the attention.
            drop(stream);
            let _ = reply.send(Err(interrupt(client, state).await));
            return None;
        }
    };
    let (columns, rows) = first.unwrap_or_default();
    let mut read = rows.len() as u64;
    let more = pending.is_some() && params.max_rows.is_none_or(|max| read < max);
    let cursor = more.then(|| {
        state.cursors += 1;
        format!("mssql_cursor_{}", state.cursors)
    });
    let _ = reply.send(Ok(ExecuteResult {
        columns,
        rows,
        cursor: cursor.clone(),
        affected: None,
        notices: notices(),
        elapsed_ms: started.elapsed().as_millis() as u64,
        results: further,
    }));
    let cursor = cursor?;
    loop {
        let command = commands.recv().await?;
        match command {
            Command::Fetch {
                cursor: wanted,
                rows: count,
                reply,
            } if wanted == cursor => {
                let count = params
                    .max_rows
                    .map_or(count, |max| max.saturating_sub(read).min(count));
                let mut page: Vec<Vec<Value>> =
                    pending.take().map(values::row).into_iter().collect();
                let mut ended = false;
                while (page.len() as u64) < count {
                    match stream.try_next().await {
                        Ok(Some(QueryItem::Row(row))) => page.push(values::row(row)),
                        Ok(_) => {
                            ended = true;
                            break;
                        }
                        Err(error) => {
                            let _ = reply.send(Err(driver_error(error)));
                            return None;
                        }
                    }
                }
                read += page.len() as u64;
                if !ended && params.max_rows.is_none_or(|max| read < max) {
                    match stream.try_next().await {
                        Ok(Some(QueryItem::Row(row))) => pending = Some(row),
                        _ => ended = true,
                    }
                } else {
                    ended = true;
                }
                let _ = reply.send(Ok(Page {
                    rows: page,
                    cursor: (!ended).then(|| cursor.clone()),
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
            // Anything else ends the result: SQL Server reads one at a time per connection.
            other => return Some(other),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{counts_rows, first_word};

    #[test]
    fn tells_writes_that_count_rows() {
        assert_eq!(first_word("  -- a\n/* b */ update t set a = 1"), "UPDATE");
        assert!(counts_rows("INSERT INTO t VALUES (1)"));
        assert!(!counts_rows("INSERT INTO t OUTPUT inserted.id VALUES (1)"));
        assert!(!counts_rows("SELECT 1"));
        assert!(!counts_rows("EXEC shop.two_results"));
        assert!(!counts_rows("CREATE TABLE #t (a int)"));
    }
}
