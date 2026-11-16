//! Running what a request sends: one statement, or several as a script gives them. The last
//! result read by pages stays open as a cursor; the others are read whole, within a page.
use super::{
    Command, Session, bind,
    cursor::{keep_open, page},
};
use crate::{errors::database, values};
use nexo_driver_sdk::{
    Result, Value, limits,
    statements::{ExecuteParams, ExecuteResult, Notice, ResultSet},
};
use rusqlite::{Batch, fallible_iterator::FallibleIterator};
use std::time::Instant;
use tokio::sync::{mpsc, oneshot};

type Reply = oneshot::Sender<Result<ExecuteResult>>;

/// The first word of a statement, after comments and spaces.
pub(crate) fn first_word(sql: &str) -> String {
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

/// Statements that manual mode does not put in a transaction: those that open or end one
/// themselves, and those SQLite runs only outside one.
fn outside_transaction(word: &str) -> bool {
    matches!(
        word,
        "" | "BEGIN"
            | "COMMIT"
            | "END"
            | "ROLLBACK"
            | "SAVEPOINT"
            | "RELEASE"
            | "VACUUM"
            | "PRAGMA"
            | "ATTACH"
            | "DETACH"
    )
}

/// Binds the values of a request to a statement that takes them.
fn bound(statement: &mut rusqlite::Statement<'_>, params: &[Value]) -> rusqlite::Result<()> {
    let wanted = statement.parameter_count();
    if params.is_empty() && wanted == 0 {
        return Ok(());
    }
    if wanted != params.len() {
        return Err(rusqlite::Error::InvalidParameterCount(params.len(), wanted));
    }
    bind(statement, params)
}

/// Runs a request and answers `reply`. A result with more rows than its first page stays
/// open as a cursor until it is read, closed, or another request comes: that request is
/// returned, for the session to do next.
pub(super) fn run(
    session: &mut Session,
    params: ExecuteParams,
    reply: Reply,
    commands: &mut mpsc::Receiver<Command>,
) -> Option<Command> {
    let running = session.running.clone();
    running.start(&params.statement);
    session.guard.arm(limits::STATEMENT);
    session.cursors += 1;
    let cursor = format!("sqlite_cursor_{}", session.cursors);
    let next = execute(session, &params, reply, commands, cursor);
    session.guard.disarm();
    running.stop();
    next
}

fn execute(
    session: &Session,
    params: &ExecuteParams,
    reply: Reply,
    commands: &mut mpsc::Receiver<Command>,
    cursor: String,
) -> Option<Command> {
    let (conn, guard) = (&session.conn, &session.guard);
    let started = Instant::now();
    let sql = params.sql.as_str();
    let fail = |error, prepared| Err(database(error, Some(sql), guard, prepared));
    let word = first_word(sql);
    if !session.auto_commit
        && conn.is_autocommit()
        && !outside_transaction(&word)
        && let Err(error) = conn.execute_batch("BEGIN")
    {
        let _ = reply.send(fail(error, false));
        return None;
    }
    let page_rows = limits::page_rows(params.page_rows) as u64;
    let first_page = params.max_rows.map_or(page_rows, |max| max.min(page_rows));
    let mut batch = Batch::new(conn, sql);
    let mut result = ExecuteResult::default();
    let (mut shown, mut changed, mut index) = (false, None::<u64>, 0);
    let mut next = match batch.next() {
        Ok(next) => next,
        Err(error) => {
            let _ = reply.send(fail(error, true));
            return None;
        }
    };
    while let Some(mut statement) = next.take() {
        index += 1;
        if let Err(error) = bound(&mut statement, &params.params) {
            let _ = reply.send(fail(error, false));
            return None;
        }
        if statement.column_count() == 0 {
            if let Err(error) = statement.raw_execute() {
                let _ = reply.send(fail(error, false));
                return None;
            }
            changed = Some(changed.unwrap_or(0) + conn.changes());
            drop(statement);
            next = match batch.next() {
                Ok(next) => next,
                Err(error) => {
                    let _ = reply.send(fail(error, true));
                    return None;
                }
            };
            continue;
        }
        let mut columns = values::columns(&statement);
        let width = columns.len();
        let mut rows = statement.raw_query();
        let mut ahead = None;
        let look = params.max_rows.is_none_or(|max| max > first_page);
        let (first, ended) = match page(&mut rows, &mut ahead, first_page, width, look) {
            Ok(read) => read,
            Err(error) => {
                let _ = reply.send(fail(error, false));
                return None;
            }
        };
        values::typed_by_values(&mut columns, &first);
        // The statement after this one, read while this one is open: it cannot depend on it.
        next = match batch.next() {
            Ok(next) => next,
            Err(error) => {
                let _ = reply.send(fail(error, true));
                return None;
            }
        };
        if shown {
            result.results.push(ResultSet {
                columns,
                rows: first,
                truncated: !ended,
            });
            continue;
        }
        shown = true;
        result.columns = columns;
        result.rows = first;
        if ended {
            continue;
        }
        if next.is_some() {
            result.notices.push(Notice {
                severity: "warning".into(),
                message: format!(
                    "Statement {index} gave more rows than these {first_page}: run it alone to read them all"
                ),
            });
            continue;
        }
        result.cursor = Some(cursor.clone());
        result.elapsed_ms = started.elapsed().as_millis() as u64;
        let _ = reply.send(Ok(result));
        let read = first_page;
        return keep_open(
            rows,
            ahead,
            width,
            read,
            params.max_rows,
            &cursor,
            guard,
            commands,
        );
    }
    if !shown {
        result.affected = changed;
        if matches!(word.as_str(), "INSERT" | "REPLACE") && changed.is_some_and(|rows| rows > 0) {
            result.notices.push(Notice {
                severity: "info".into(),
                message: format!("Last inserted rowid: {}", conn.last_insert_rowid()),
            });
        }
    }
    result.elapsed_ms = started.elapsed().as_millis() as u64;
    let _ = reply.send(Ok(result));
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_first_word_and_what_stays_out_of_a_transaction() {
        assert_eq!(first_word("  -- a\n/* b */ update t set a = 1"), "UPDATE");
        assert!(outside_transaction(&first_word("VACUUM")));
        assert!(outside_transaction(&first_word("end transaction")));
        assert!(!outside_transaction(&first_word(
            "INSERT INTO t VALUES (1)"
        )));
    }
}
