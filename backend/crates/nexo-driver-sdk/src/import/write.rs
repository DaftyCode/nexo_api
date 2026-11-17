//! Writing a batch of rows: see [`super`].
use super::{
    FAILURES_KEPT, ImportFailure, ImportMode, ImportParams, Imported,
    build::{MAX_PARAMS, check, insert, upsert},
};
use crate::{
    Driver, DriverError, Result, Value,
    statements::{ExecuteParams, TransactionAction, TransactionParams},
};

const BATCH: &str = "nexo_import";
const ROW: &str = "nexo_import_row";
const CHUNK: &str = "nexo_import_chunk";

async fn run<D: Driver + ?Sized>(
    driver: &D,
    connection: &str,
    name: &str,
    sql: String,
    params: Vec<Value>,
) -> Result<u64> {
    let answer = driver
        .execute(ExecuteParams {
            connection: connection.to_owned(),
            statement: name.to_owned(),
            sql,
            params,
            page_rows: Some(1),
            max_rows: Some(1),
        })
        .await?;
    Ok(answer.affected.unwrap_or(0))
}

/// The statements of savepoints in the dialect: set, undo, and release (none in T-SQL).
struct Savepoints {
    tsql: bool,
}
impl Savepoints {
    fn set(&self, name: &str) -> String {
        if self.tsql {
            format!("SAVE TRANSACTION {name}")
        } else {
            format!("SAVEPOINT {name}")
        }
    }
    fn undo(&self, name: &str) -> String {
        if self.tsql {
            format!("ROLLBACK TRANSACTION {name}")
        } else {
            format!("ROLLBACK TO SAVEPOINT {name}")
        }
    }
    fn release(&self, name: &str) -> Option<String> {
        (!self.tsql).then(|| format!("RELEASE SAVEPOINT {name}"))
    }
}

fn failure(position: u64, last: Option<u64>, error: &DriverError) -> ImportFailure {
    ImportFailure {
        position,
        last,
        message: error.message.clone(),
    }
}

/// Writes a batch of rows with `driver`'s own `execute` and `transaction`.
pub async fn write<D: Driver + ?Sized>(driver: &D, params: ImportParams) -> Result<Imported> {
    // A batch that cannot be written opens no transaction.
    check(&params)?;
    let dialect = driver.hello().dialect;
    let connection = params.connection.as_str();
    let points = Savepoints {
        tsql: dialect.name == "tsql",
    };
    let action = |action| TransactionParams {
        connection: connection.to_owned(),
        action,
        isolation: None,
    };
    let state = driver
        .transaction(action(TransactionAction::Status))
        .await?;
    // Its own transaction in auto-commit; behind a savepoint inside one open or in manual
    // commit, where the person commits it.
    let own = state.auto_commit && !state.open;
    if own {
        driver.transaction(action(TransactionAction::Begin)).await?;
    } else {
        run(
            driver,
            connection,
            "import-batch",
            points.set(BATCH),
            Vec::new(),
        )
        .await?;
    }
    let outcome = rows(driver, &params, &dialect, &points).await;
    let undo_all = matches!(&outcome, Err(_) | Ok(Imported { stopped: true, .. }));
    match (undo_all, own) {
        (true, true) => {
            driver
                .transaction(action(TransactionAction::Rollback))
                .await?;
        }
        (true, false) => {
            run(
                driver,
                connection,
                "import-undo",
                points.undo(BATCH),
                Vec::new(),
            )
            .await?;
        }
        (false, true) => {
            driver
                .transaction(action(TransactionAction::Commit))
                .await?;
        }
        (false, false) => {
            if let Some(release) = points.release(BATCH) {
                run(driver, connection, "import-release", release, Vec::new()).await?;
            }
        }
    }
    outcome
}

async fn rows<D: Driver + ?Sized>(
    driver: &D,
    params: &ImportParams,
    dialect: &crate::protocol::Dialect,
    points: &Savepoints,
) -> Result<Imported> {
    let connection = params.connection.as_str();
    let mut done = Imported::default();
    if params.mode == ImportMode::Upsert {
        let sql = upsert(dialect, params)?;
        one_by_one(driver, params, points, &sql, 0, &params.rows, &mut done).await?;
        return Ok(done);
    }
    // Inserts go many rows at a time. Going on after failures, a chunk that fails is undone
    // and its rows inserted one by one, to say which of them failed and why.
    let per = (MAX_PARAMS / params.columns.len()).clamp(1, 1_000);
    for (chunk, rows) in params.rows.chunks(per).enumerate() {
        let sql = insert(dialect, params, rows.len())?;
        let values: Vec<Value> = rows.iter().flatten().cloned().collect();
        let offset = chunk * per;
        let first = params.first + offset as u64;
        if !params.stop_on_error {
            run(
                driver,
                connection,
                "import-chunk",
                points.set(CHUNK),
                Vec::new(),
            )
            .await?;
        }
        match run(driver, connection, "import-rows", sql, values).await {
            Ok(_) => {
                done.inserted += rows.len() as u64;
                if !params.stop_on_error
                    && let Some(release) = points.release(CHUNK)
                {
                    run(driver, connection, "import-chunk", release, Vec::new()).await?;
                }
            }
            Err(error) if params.stop_on_error => {
                let last = (rows.len() > 1).then(|| first + rows.len() as u64 - 1);
                return Ok(Imported {
                    failed: 1,
                    failures: vec![failure(first, last, &error)],
                    stopped: true,
                    ..Imported::default()
                });
            }
            Err(_) => {
                run(
                    driver,
                    connection,
                    "import-chunk",
                    points.undo(CHUNK),
                    Vec::new(),
                )
                .await?;
                let sql = insert(dialect, params, 1)?;
                one_by_one(driver, params, points, &sql, offset, rows, &mut done).await?;
            }
        }
    }
    Ok(done)
}

/// Writes rows one statement each, from `offset` of the batch: going on after failures,
/// each behind a savepoint that undoes it alone.
async fn one_by_one<D: Driver + ?Sized>(
    driver: &D,
    params: &ImportParams,
    points: &Savepoints,
    sql: &str,
    offset: usize,
    rows: &[Vec<Value>],
    done: &mut Imported,
) -> Result<()> {
    let connection = params.connection.as_str();
    for (at, row) in rows.iter().enumerate() {
        let position = params.first + (offset + at) as u64;
        if !params.stop_on_error {
            run(
                driver,
                connection,
                "import-row",
                points.set(ROW),
                Vec::new(),
            )
            .await?;
        }
        match run(
            driver,
            connection,
            "import-row",
            sql.to_owned(),
            row.clone(),
        )
        .await
        {
            Ok(_) => {
                match params.mode {
                    ImportMode::Insert => done.inserted += 1,
                    ImportMode::Upsert => done.upserted += 1,
                }
                if !params.stop_on_error
                    && let Some(release) = points.release(ROW)
                {
                    run(driver, connection, "import-row", release, Vec::new()).await?;
                }
            }
            Err(error) if params.stop_on_error => {
                *done = Imported {
                    failed: 1,
                    failures: vec![failure(position, None, &error)],
                    stopped: true,
                    ..Imported::default()
                };
                return Ok(());
            }
            Err(error) => {
                run(
                    driver,
                    connection,
                    "import-row",
                    points.undo(ROW),
                    Vec::new(),
                )
                .await?;
                done.failed += 1;
                if done.failures.len() < FAILURES_KEPT {
                    done.failures.push(failure(position, None, &error));
                }
            }
        }
    }
    Ok(())
}
