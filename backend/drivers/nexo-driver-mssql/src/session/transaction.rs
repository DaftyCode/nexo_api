//! Transactions: automatic commits, or manual ones as SQL Server's implicit transactions
//! (every statement opens one until it is committed), with the isolation levels it has.
use super::{Sql, State, batch, query_rows};
use nexo_driver_sdk::{
    DriverError, Result, Value,
    statements::{TransactionAction, TransactionState},
};

const LEVELS: [&str; 5] = [
    "READ UNCOMMITTED",
    "READ COMMITTED",
    "REPEATABLE READ",
    "SNAPSHOT",
    "SERIALIZABLE",
];

pub(super) async fn status(client: &mut Sql, state: &State) -> Result<TransactionState> {
    let rows = query_rows(client, "SELECT @@TRANCOUNT", &[]).await?;
    let open =
        matches!(rows.rows.first().and_then(|row| row.first()), Some(Value::Integer(n)) if *n > 0);
    Ok(TransactionState {
        auto_commit: state.auto_commit,
        open,
    })
}

pub(super) async fn run(
    client: &mut Sql,
    state: &mut State,
    action: TransactionAction,
    isolation: Option<String>,
) -> Result<TransactionState> {
    if let Some(level) = isolation {
        let level = level.trim().to_ascii_uppercase();
        if !LEVELS.contains(&level.as_str()) {
            return Err(DriverError::invalid(format!(
                "SQL Server has no isolation level {level}: use {}",
                LEVELS.join(", ")
            )));
        }
        batch(client, &format!("SET TRANSACTION ISOLATION LEVEL {level}")).await?;
        state.isolation = Some(level);
    }
    match action {
        TransactionAction::Status => {}
        TransactionAction::Begin => batch(client, "BEGIN TRANSACTION").await?,
        TransactionAction::Commit => batch(client, "IF @@TRANCOUNT > 0 COMMIT").await?,
        TransactionAction::Rollback => batch(client, "IF @@TRANCOUNT > 0 ROLLBACK").await?,
        TransactionAction::Manual => {
            batch(client, "SET IMPLICIT_TRANSACTIONS ON").await?;
            state.auto_commit = false;
        }
        TransactionAction::Auto => {
            batch(
                client,
                "IF @@TRANCOUNT > 0 COMMIT; SET IMPLICIT_TRANSACTIONS OFF",
            )
            .await?;
            state.auto_commit = true;
        }
    }
    status(client, state).await
}
