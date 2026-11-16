//! Transactions of a session. SQLite says itself whether one is open; manual mode begins one
//! before the next statement, as the SQLite JDBC driver DBeaver uses does.
use super::Session;
use crate::errors::database;
use nexo_driver_sdk::{
    DriverError, Result,
    statements::{TransactionAction, TransactionState},
};

/// How a transaction begins: SQLite's transactions are serializable; `immediate` and
/// `exclusive` take the write lock at once.
fn begin_statement(isolation: Option<&str>) -> Result<&'static str> {
    match isolation
        .map(|level| level.trim().to_ascii_lowercase())
        .as_deref()
    {
        None | Some("" | "serializable" | "deferred") => Ok("BEGIN"),
        Some("immediate") => Ok("BEGIN IMMEDIATE"),
        Some("exclusive") => Ok("BEGIN EXCLUSIVE"),
        Some(other) => Err(DriverError::unsupported(format!(
            "SQLite has no isolation level {other}: its transactions are serializable \
             (deferred, immediate or exclusive)"
        ))),
    }
}

pub(super) fn run(
    session: &mut Session,
    action: TransactionAction,
    isolation: Option<String>,
) -> Result<TransactionState> {
    let open = !session.conn.is_autocommit();
    let sql = match action {
        TransactionAction::Status => None,
        TransactionAction::Begin if open => {
            return Err(DriverError::invalid("A transaction is already open"));
        }
        TransactionAction::Begin => Some(begin_statement(isolation.as_deref())?),
        TransactionAction::Commit | TransactionAction::Auto if open => Some("COMMIT"),
        TransactionAction::Rollback if open => Some("ROLLBACK"),
        TransactionAction::Commit | TransactionAction::Rollback | TransactionAction::Auto => None,
        TransactionAction::Manual => None,
    };
    if let Some(sql) = sql {
        let guard = &session.guard;
        session
            .conn
            .execute_batch(sql)
            .map_err(|error| database(error, Some(sql), guard, false))?;
    }
    match action {
        TransactionAction::Auto => session.auto_commit = true,
        TransactionAction::Manual => session.auto_commit = false,
        _ => {}
    }
    Ok(session.state())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn begins_as_sqlite_does() {
        assert_eq!(begin_statement(None).unwrap(), "BEGIN");
        assert_eq!(
            begin_statement(Some("Immediate")).unwrap(),
            "BEGIN IMMEDIATE"
        );
        assert!(begin_statement(Some("read committed")).is_err());
    }
}
