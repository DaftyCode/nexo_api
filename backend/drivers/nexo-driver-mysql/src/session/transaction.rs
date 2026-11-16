//! The transaction of a session: auto-commit or by hand, begun with an isolation level,
//! committed or rolled back.
use super::State;
use crate::errors::database;
use mysql_async::{Conn, prelude::Queryable};
use nexo_driver_sdk::{
    DriverError, Result,
    statements::{TransactionAction, TransactionState},
};

const ISOLATIONS: [&str; 4] = [
    "read uncommitted",
    "read committed",
    "repeatable read",
    "serializable",
];

async fn run_sql(conn: &mut Conn, sql: &str) -> Result<()> {
    conn.query_drop(sql)
        .await
        .map_err(|error| database(error, Some(sql)))
}

pub(super) async fn run(
    conn: &mut Conn,
    state: &mut State,
    action: TransactionAction,
    isolation: Option<String>,
) -> Result<TransactionState> {
    match action {
        TransactionAction::Status | TransactionAction::Begin if state.open => {}
        TransactionAction::Status => {}
        TransactionAction::Begin => {
            if let Some(level) = isolation.map(|level| level.to_ascii_lowercase()) {
                if !ISOLATIONS.contains(&level.as_str()) {
                    return Err(DriverError::invalid(format!(
                        "MySQL has no isolation level {level}"
                    )));
                }
                run_sql(conn, &format!("SET TRANSACTION ISOLATION LEVEL {level}")).await?;
            }
            run_sql(conn, "START TRANSACTION").await?;
            state.open = true;
        }
        TransactionAction::Commit | TransactionAction::Rollback | TransactionAction::Auto => {
            if state.open {
                let word = if action == TransactionAction::Rollback {
                    "ROLLBACK"
                } else {
                    "COMMIT"
                };
                run_sql(conn, word).await?;
                state.open = false;
            }
            if action == TransactionAction::Auto && !state.auto_commit {
                run_sql(conn, "SET autocommit = 1").await?;
                state.auto_commit = true;
            }
        }
        TransactionAction::Manual => {
            if state.auto_commit {
                run_sql(conn, "SET autocommit = 0").await?;
                state.auto_commit = false;
            }
        }
    }
    Ok(TransactionState {
        auto_commit: state.auto_commit,
        open: state.open,
    })
}
