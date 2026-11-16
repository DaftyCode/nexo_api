//! Running a statement: its results read as they come (the first one by pages, the next ones
//! whole, as a procedure returns them), the rows a write changed, the id it inserted and the
//! warnings the server kept for it.
use super::{
    Command, State,
    read::{Either, Read, read_first},
};
use crate::{errors::database, values};
use mysql_async::{Column as MyColumn, Conn, prelude::Queryable};
use nexo_driver_sdk::{
    Result, Value, limits,
    statements::{ExecuteParams, ExecuteResult, Notice, Page},
};
use std::{sync::Arc, time::Instant};
use tokio::sync::{mpsc, oneshot};

/// The first word of a statement, after comments and spaces.
pub(crate) fn first_word(sql: &str) -> String {
    let mut rest = sql.trim_start();
    loop {
        if let Some(after) = rest.strip_prefix("--").or_else(|| rest.strip_prefix('#')) {
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

/// Statements that end the transaction they are in, explicitly or by an implicit commit.
fn ends_transaction(word: &str, sql: &str) -> bool {
    match word {
        "COMMIT" => true,
        "ROLLBACK" => !sql.to_ascii_uppercase().contains(" TO "),
        "CREATE" | "ALTER" | "DROP" | "RENAME" | "TRUNCATE" | "GRANT" | "REVOKE" => true,
        _ => false,
    }
}

/// The warnings the server kept for the last statement, as notices.
async fn warnings(conn: &mut Conn) -> Vec<Notice> {
    let found: Vec<(String, u32, String)> = conn.query("SHOW WARNINGS").await.unwrap_or_default();
    found
        .into_iter()
        .map(|(level, code, message)| Notice {
            severity: match level.as_str() {
                "Error" => "error",
                "Warning" => "warning",
                _ => "info",
            }
            .into(),
            message: format!("{message} ({code})"),
        })
        .collect()
}

/// Runs a statement and answers `reply`. A result with more rows than its first page stays
/// open as a cursor until it is read, closed, or another request comes: that request is
/// returned, for the session to do next.
pub(super) async fn run(
    conn: &mut Conn,
    params: ExecuteParams,
    reply: oneshot::Sender<Result<ExecuteResult>>,
    commands: &mut mpsc::Receiver<Command>,
    state: &mut State,
) -> Option<Command> {
    let started = Instant::now();
    let sql = params.sql.clone();
    let word = first_word(&sql);
    let page = limits::page_rows(params.page_rows) as u64;
    let first_page = params.max_rows.map_or(page, |max| max.min(page));
    let opened = if params.params.is_empty() {
        conn.query_iter(sql.as_str()).await.map(Either::Text)
    } else {
        conn.exec_iter(sql.as_str(), super::params(&params.params))
            .await
            .map(Either::Binary)
    };
    let mut opened = match opened {
        Ok(opened) => opened,
        Err(error) => {
            let error = Err(database(error, Some(&sql)));
            state.note(&error);
            let _ = reply.send(error);
            return None;
        }
    };
    let read = match &mut opened {
        Either::Text(result) => read_first(result, first_page).await,
        Either::Binary(result) => read_first(result, first_page).await,
    };
    let read = match read {
        Ok(read) => read,
        Err(error) => {
            drop(opened);
            let error = Err(database(error, Some(&sql)));
            state.note(&error);
            let _ = reply.send(error);
            return None;
        }
    };
    let Read {
        first,
        further,
        mut pending,
        affected,
        inserted,
    } = read;
    let (columns, rows, meta) = first.unwrap_or_default();
    let mut read_rows = rows.len() as u64;
    let more = pending.is_some() && params.max_rows.is_none_or(|max| read_rows < max);
    // In manual mode every statement opens a transaction, unless it ends one.
    if !state.auto_commit || matches!(word.as_str(), "BEGIN" | "START") {
        state.open = !ends_transaction(&word, &sql);
    } else if ends_transaction(&word, &sql) {
        state.open = false;
    }
    if !more {
        drop(opened);
        let mut notices = Vec::new();
        if let Some(id) = inserted {
            notices.push(Notice {
                severity: "info".into(),
                message: format!("Last inserted id: {id}"),
            });
        }
        notices.extend(warnings(conn).await);
        let _ = reply.send(Ok(ExecuteResult {
            affected: if columns.is_empty() { affected } else { None },
            columns,
            rows,
            cursor: None,
            notices,
            elapsed_ms: started.elapsed().as_millis() as u64,
            results: further,
        }));
        return None;
    }
    state.cursors += 1;
    let cursor = format!("mysql_cursor_{}", state.cursors);
    let _ = reply.send(Ok(ExecuteResult {
        columns,
        rows,
        cursor: Some(cursor.clone()),
        affected: None,
        notices: Vec::new(),
        elapsed_ms: started.elapsed().as_millis() as u64,
        results: further,
    }));
    let meta = meta.unwrap_or_else(|| Arc::from(Vec::<MyColumn>::new()));
    loop {
        let Some(command) = commands.recv().await else {
            let _ = opened.drop_result().await;
            return None;
        };
        match command {
            Command::Fetch {
                cursor: wanted,
                rows: count,
                reply,
            } if wanted == cursor => {
                let count = params
                    .max_rows
                    .map_or(count, |max| max.saturating_sub(read_rows).min(count));
                let mut page: Vec<Vec<Value>> = pending
                    .take()
                    .map(|row| values::row(row, &meta))
                    .into_iter()
                    .collect();
                let mut ended = false;
                while (page.len() as u64) < count {
                    match opened.next().await {
                        Ok(Some(row)) => page.push(values::row(row, &meta)),
                        Ok(None) => {
                            ended = true;
                            break;
                        }
                        Err(error) => {
                            let error = Err(database(error, None));
                            state.note(&error);
                            let _ = reply.send(error);
                            return None;
                        }
                    }
                }
                read_rows += page.len() as u64;
                if !ended && params.max_rows.is_none_or(|max| read_rows < max) {
                    match opened.next().await {
                        Ok(Some(row)) => pending = Some(row),
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
                    let _ = opened.drop_result().await;
                    return None;
                }
            }
            Command::Close {
                cursor: wanted,
                reply,
            } if wanted == cursor => {
                let _ = opened.drop_result().await;
                let _ = reply.send(Ok(()));
                return None;
            }
            // Anything else ends the result: the server answers one request at a time.
            other => {
                let _ = opened.drop_result().await;
                return Some(other);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_first_word_and_what_ends_a_transaction() {
        assert_eq!(
            first_word("  -- a\n# b\n/* c */ update t set a = 1"),
            "UPDATE"
        );
        assert!(ends_transaction("COMMIT", "COMMIT"));
        assert!(ends_transaction("CREATE", "CREATE TABLE t (a int)"));
        assert!(!ends_transaction("ROLLBACK", "ROLLBACK TO SAVEPOINT a"));
        assert!(!ends_transaction("SELECT", "SELECT 1"));
    }
}
