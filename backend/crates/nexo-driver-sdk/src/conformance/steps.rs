//! The longer checks: reading a result by pages, cancelling a statement and rolling a
//! transaction back.
use super::{Checks, Suite};
use crate::{
    ErrorCode,
    statements::{
        CancelParams, CursorParams, ExecuteResult, FetchParams, TransactionAction,
        TransactionParams,
    },
};
use std::time::{Duration, Instant};

pub(super) async fn pages(checks: &mut Checks, suite: &Suite) {
    let page = Suite::PAGE as usize;
    let first = match checks.execute(&suite.paged_sql).await {
        Ok(first) => first,
        Err(error) => return checks.expect("the paged statement", false, error),
    };
    checks.expect(
        "the result has columns",
        !first.columns.is_empty(),
        &first.columns,
    );
    checks.expect(
        "the first page is full",
        first.rows.len() == page,
        first.rows.len(),
    );
    let mut total = first.rows.len();
    let mut cursor = first.cursor;
    checks.expect("more rows leave a cursor", cursor.is_some(), &cursor);
    while let Some(open) = cursor.take() {
        let params = FetchParams {
            connection: checks.connection.clone(),
            cursor: open,
            page_rows: Some(Suite::PAGE),
        };
        match checks.client.fetch(&params).await {
            Ok(next) => {
                checks.expect(
                    "a page within its size",
                    next.rows.len() <= page,
                    next.rows.len(),
                );
                total += next.rows.len();
                cursor = next.cursor;
            }
            Err(error) => return checks.expect("fetch", false, error),
        }
    }
    checks.expect("every row is read once", total == suite.paged_rows, total);

    // A cursor closed before its end cannot be read again.
    let Ok(ExecuteResult {
        cursor: Some(cursor),
        ..
    }) = checks.execute(&suite.paged_sql).await
    else {
        return checks.expect("a second run leaves a cursor", false, ());
    };
    let closing = CursorParams {
        connection: checks.connection.clone(),
        cursor: cursor.clone(),
    };
    let outcome = checks.client.close(&closing).await;
    checks.expect("close", outcome.is_ok(), outcome);
    let params = FetchParams {
        connection: checks.connection.clone(),
        cursor,
        page_rows: None,
    };
    let outcome = checks.client.fetch(&params).await;
    checks.code("a closed cursor is refused", outcome, ErrorCode::Invalid);
}

pub(super) async fn cancel(checks: &mut Checks, sql: &str, supported: bool) {
    checks.expect("a driver with a slow statement can cancel", supported, ());
    let params = checks.statement(sql);
    let cancelling = CancelParams {
        connection: params.connection.clone(),
        statement: params.statement.clone(),
    };
    let client = checks.client.clone();
    let running = tokio::spawn(async move { client.execute(&params).await });
    tokio::time::sleep(Duration::from_millis(300)).await;
    let started = Instant::now();
    let outcome = checks.client.cancel(&cancelling).await;
    checks.expect("cancel", outcome.is_ok(), outcome);
    match tokio::time::timeout(Duration::from_secs(10), running).await {
        Ok(Ok(outcome)) => {
            checks.code(
                "a cancelled statement says so",
                outcome,
                ErrorCode::Cancelled,
            );
        }
        _ => checks.expect("a cancelled statement ends", false, started.elapsed()),
    }
}

pub(super) async fn rollback(checks: &mut Checks, write: &str, count: &str) {
    let before = checks.single(count).await;
    let transaction = |action| TransactionParams {
        connection: checks.connection.clone(),
        action,
        isolation: None,
    };
    let (begin, undo) = (
        transaction(TransactionAction::Begin),
        transaction(TransactionAction::Rollback),
    );
    let outcome = checks.client.transaction(&begin).await;
    checks.expect("begin", matches!(outcome, Ok(state) if state.open), outcome);
    let outcome = checks.execute(write).await;
    checks.expect("a write inside a transaction", outcome.is_ok(), outcome);
    let outcome = checks.client.transaction(&undo).await;
    checks.expect(
        "rollback",
        matches!(outcome, Ok(state) if !state.open),
        outcome,
    );
    let after = checks.single(count).await;
    checks.expect(
        "a rollback undoes the write",
        before.is_some() && before == after,
        (before, after),
    );
}
