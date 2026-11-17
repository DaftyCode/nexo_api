//! Running the statements of a write as one: in a transaction of its own when the session
//! commits by itself, behind a savepoint inside one already open, or opening the manual
//! transaction that the person commits later. Any failure undoes the whole write.
use super::{RowsWriteParams, RowsWritten, statements};
use crate::{
    Driver, DriverError, Result,
    statements::{ExecuteParams, TransactionAction, TransactionParams},
};
use serde_json::json;

const SAVEPOINT: &str = "nexo_rows";

/// How the write is undone if a statement fails, and kept if none does.
enum Scope {
    /// Its own transaction, committed at the end.
    Own,
    /// Inside the open transaction, behind a savepoint.
    Savepoint,
    /// The first statements of a manual transaction, left open for the person.
    Manual,
}

/// The statements that set, undo and drop a savepoint in the dialect.
fn savepoint(dialect: &str) -> (String, String, Option<String>) {
    if dialect == "tsql" {
        (
            format!("SAVE TRANSACTION {SAVEPOINT}"),
            format!("ROLLBACK TRANSACTION {SAVEPOINT}"),
            None,
        )
    } else {
        (
            format!("SAVEPOINT {SAVEPOINT}"),
            format!("ROLLBACK TO SAVEPOINT {SAVEPOINT}"),
            Some(format!("RELEASE SAVEPOINT {SAVEPOINT}")),
        )
    }
}

async fn run<D: Driver + ?Sized>(
    driver: &D,
    connection: &str,
    name: String,
    sql: String,
    params: Vec<crate::Value>,
) -> Result<u64> {
    let answer = driver
        .execute(ExecuteParams {
            connection: connection.to_owned(),
            statement: name,
            sql,
            params,
            page_rows: Some(1),
            max_rows: Some(1),
        })
        .await?;
    Ok(answer.affected.unwrap_or(0))
}

/// The error of a statement, saying which change it was (its own detail kept).
fn at_change(mut error: DriverError, index: usize) -> DriverError {
    let mut detail = error.detail.take().unwrap_or_else(|| json!({}));
    if let Some(fields) = detail.as_object_mut() {
        fields.insert("change".into(), json!(index));
    }
    error.with_detail(detail)
}

/// Writes the changes of `params` with `driver`'s own `execute` and `transaction`.
pub async fn write<D: Driver + ?Sized>(driver: &D, params: RowsWriteParams) -> Result<RowsWritten> {
    let dialect = driver.hello().dialect;
    let built = statements(&dialect, &params)?;
    let connection = params.connection.as_str();
    let action = |action| TransactionParams {
        connection: connection.to_owned(),
        action,
        isolation: None,
    };
    let state = driver
        .transaction(action(TransactionAction::Status))
        .await?;
    let (set, undo, release) = savepoint(&dialect.name);
    let scope = if state.open {
        run(driver, connection, "rows-savepoint".into(), set, Vec::new()).await?;
        Scope::Savepoint
    } else if state.auto_commit {
        driver.transaction(action(TransactionAction::Begin)).await?;
        Scope::Own
    } else {
        Scope::Manual
    };
    let mut written = RowsWritten::default();
    let mut failure: Option<DriverError> = None;
    for (index, statement) in built.into_iter().enumerate() {
        written.statements.push(statement.sql.clone());
        let name = format!("rows-{}", index + 1);
        match run(driver, connection, name, statement.sql, statement.params).await {
            Ok(affected) if statement.one_row && affected != 1 => {
                let why = if affected == 0 {
                    "it found no row: another session changed or deleted it"
                } else {
                    "it found several rows: the key does not name one row"
                };
                failure = Some(
                    DriverError::invalid(format!(
                        "Change {} was not saved, and nor was any other: {why}",
                        index + 1
                    ))
                    .with_detail(json!({"change": index, "affected": affected})),
                );
                break;
            }
            Ok(affected) => written.affected += affected,
            Err(error) => {
                failure = Some(at_change(error, index));
                break;
            }
        }
    }
    match (failure, scope) {
        (Some(error), Scope::Savepoint) => {
            run(driver, connection, "rows-undo".into(), undo, Vec::new()).await?;
            Err(error)
        }
        (Some(error), Scope::Own | Scope::Manual) => {
            driver
                .transaction(action(TransactionAction::Rollback))
                .await?;
            Err(error)
        }
        (None, Scope::Own) => {
            driver
                .transaction(action(TransactionAction::Commit))
                .await?;
            Ok(written)
        }
        (None, Scope::Savepoint) => {
            if let Some(release) = release {
                run(
                    driver,
                    connection,
                    "rows-release".into(),
                    release,
                    Vec::new(),
                )
                .await?;
            }
            Ok(written)
        }
        (None, Scope::Manual) => Ok(written),
    }
}
