//! The plan of a statement with a driver's own `execute` and `transaction`.
use super::{ExplainMode, ExplainParams, Plan, PlanReader};
use crate::{
    Driver, DriverError, Result, Value,
    statements::{
        CursorParams, ExecuteParams, ExecuteResult, TransactionAction, TransactionParams,
    },
};

const SAVEPOINT: &str = "nexo_explain";
/// Rows of the plan statement's answer kept: a plan as rows (SQLite) is never this long.
const PLAN_ROWS: u32 = 10_000;

/// How the actual mode of a write is undone.
enum Undo {
    Nothing,
    /// The transaction it opened.
    Rollback,
    /// The savepoint it set inside the one already open.
    Savepoint(&'static str),
}

async fn execute<D: Driver + ?Sized>(
    driver: &D,
    connection: &str,
    name: String,
    sql: String,
    params: Vec<Value>,
    rows: u32,
) -> Result<ExecuteResult> {
    driver
        .execute(ExecuteParams {
            connection: connection.to_owned(),
            statement: name,
            sql,
            params,
            page_rows: Some(rows),
            max_rows: Some(u64::from(rows)),
        })
        .await
}

/// Opens what keeps the actual mode of a write from changing anything.
async fn guard<D: Driver + ?Sized>(driver: &D, connection: &str) -> Result<Undo> {
    let action = |action| TransactionParams {
        connection: connection.to_owned(),
        action,
        isolation: None,
    };
    let state = driver
        .transaction(action(TransactionAction::Status))
        .await?;
    if state.open {
        let (set, undo) = if driver.hello().dialect.name == "tsql" {
            (
                format!("SAVE TRANSACTION {SAVEPOINT}"),
                "ROLLBACK TRANSACTION nexo_explain",
            )
        } else {
            (
                format!("SAVEPOINT {SAVEPOINT}"),
                "ROLLBACK TO SAVEPOINT nexo_explain",
            )
        };
        execute(
            driver,
            connection,
            "explain-savepoint".into(),
            set,
            Vec::new(),
            1,
        )
        .await?;
        return Ok(Undo::Savepoint(undo));
    }
    driver.transaction(action(TransactionAction::Begin)).await?;
    Ok(Undo::Rollback)
}

async fn undo<D: Driver + ?Sized>(driver: &D, connection: &str, undo: Undo) -> Result<()> {
    match undo {
        Undo::Nothing => Ok(()),
        Undo::Rollback => driver
            .transaction(TransactionParams {
                connection: connection.to_owned(),
                action: TransactionAction::Rollback,
                isolation: None,
            })
            .await
            .map(|_| ()),
        Undo::Savepoint(sql) => execute(
            driver,
            connection,
            "explain-undo".into(),
            sql.into(),
            Vec::new(),
            1,
        )
        .await
        .map(|_| ()),
    }
}

/// Runs the steps of `reader` for the plan of `params.sql`; the answer read whole.
async fn plan_answer<D: Driver + ?Sized>(
    driver: &D,
    params: &ExplainParams,
    reader: &dyn PlanReader,
) -> Result<ExecuteResult> {
    let connection = params.connection.as_str();
    let steps = reader.steps(params)?;
    let mut answer = Ok(ExecuteResult::default());
    for (index, sql) in steps.before.iter().enumerate() {
        let name = format!("{}-before-{index}", params.statement);
        if let Err(error) = execute(driver, connection, name, sql.clone(), Vec::new(), 1).await {
            answer = Err(error);
            break;
        }
    }
    if answer.is_ok() {
        answer = execute(
            driver,
            connection,
            params.statement.clone(),
            steps.plan,
            steps.params.unwrap_or_else(|| params.params.clone()),
            PLAN_ROWS,
        )
        .await;
    }
    if let Ok(read) = &answer
        && let Some(cursor) = &read.cursor
    {
        let close = CursorParams {
            connection: connection.to_owned(),
            cursor: cursor.clone(),
        };
        let _ = driver.close(close).await;
    }
    // What `before` set is undone even when the plan failed.
    for (index, sql) in steps.after.iter().enumerate() {
        let name = format!("{}-after-{index}", params.statement);
        let done = execute(driver, connection, name, sql.clone(), Vec::new(), 1).await;
        if let (Err(error), Ok(_)) = (done, &answer) {
            answer = Err(error);
        }
    }
    answer
}

/// The plan of a statement: see [`super`].
pub async fn run<D: Driver + ?Sized>(
    driver: &D,
    params: ExplainParams,
    reader: &dyn PlanReader,
) -> Result<Plan> {
    let connection = params.connection.clone();
    let guarded = params.mode == ExplainMode::Actual && params.writes;
    let undoing = if guarded {
        guard(driver, &connection).await?
    } else {
        Undo::Nothing
    };
    let answer = plan_answer(driver, &params, reader).await;
    // The write is undone whatever happened; an error undoing it wins, as it matters more.
    undo(driver, &connection, undoing).await?;
    let answer = answer?;
    let cut = answer
        .rows
        .iter()
        .chain(answer.results.iter().flat_map(|set| set.rows.iter()))
        .flatten()
        .any(|value| {
            matches!(
                value,
                Value::Typed {
                    full_size: Some(_),
                    ..
                }
            )
        });
    if cut {
        return Err(DriverError::invalid(
            "The plan is longer than a value Nexo reads whole: explain a part of the statement",
        ));
    }
    let read = reader.read(&answer, params.mode)?;
    Ok(Plan {
        mode: params.mode,
        nodes: read.nodes,
        format: read.format.into(),
        original: read.original,
        total_ms: read.total_ms,
        rolled_back: guarded,
    })
}
