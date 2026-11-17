//! The administration of a server with a driver's own `execute`: see [`super`].
use super::{
    AdminCatalog, AdminParams, KillParams, Killed, LockList, LockWait, MAX_ROWS, ServerSession,
    SessionList,
};
use crate::{
    Driver, DriverError, Result, Value,
    statements::{CursorParams, ExecuteParams},
};

/// The rows of a query of the catalog, at most [`MAX_ROWS`]; its cursor is closed.
async fn rows<D: Driver + ?Sized>(
    driver: &D,
    params: &AdminParams,
    sql: String,
    values: Vec<Value>,
) -> Result<Vec<Vec<Value>>> {
    let answer = driver
        .execute(ExecuteParams {
            connection: params.connection.clone(),
            statement: params.statement.clone(),
            sql,
            params: values,
            page_rows: Some(MAX_ROWS),
            max_rows: Some(u64::from(MAX_ROWS)),
        })
        .await?;
    if let Some(cursor) = answer.cursor {
        let close = CursorParams {
            connection: params.connection.clone(),
            cursor,
        };
        let _ = driver.close(close).await;
    }
    Ok(answer.rows)
}

fn text(row: &[Value], at: usize) -> Option<String> {
    match row.get(at)? {
        Value::Text(text) | Value::Typed { text, .. } => Some(text.clone()),
        Value::Integer(number) => Some(number.to_string()),
        Value::Float(number) => Some(number.to_string()),
        Value::Bool(value) => Some(value.to_string()),
        _ => None,
    }
    .filter(|text| !text.is_empty())
}
fn number(row: &[Value], at: usize) -> Option<f64> {
    match row.get(at)? {
        Value::Integer(number) => Some(*number as f64),
        Value::Float(number) => Some(*number),
        Value::Text(text) | Value::Typed { text, .. } => text.trim().parse().ok(),
        _ => None,
    }
}
fn flag(row: &[Value], at: usize) -> bool {
    match row.get(at) {
        Some(Value::Bool(value)) => *value,
        Some(Value::Integer(number)) => *number != 0,
        Some(Value::Text(text) | Value::Typed { text, .. }) => {
            matches!(text.as_str(), "1" | "t" | "true")
        }
        _ => false,
    }
}

/// The privilege the user lacks, or none (also when the engine cannot say).
async fn missing<D: Driver + ?Sized>(
    driver: &D,
    params: &AdminParams,
    catalog: &dyn AdminCatalog,
) -> Option<String> {
    let found = rows(driver, params, catalog.privilege(), Vec::new()).await;
    found.ok()?.first().and_then(|row| text(row, 0))
}

/// The sessions of the server. Without the privilege to read them all, the ones the engine
/// shows and the privilege that is missing; none, when it shows none.
pub async fn sessions<D: Driver + ?Sized>(
    driver: &D,
    params: AdminParams,
    catalog: &dyn AdminCatalog,
) -> Result<SessionList> {
    let privilege = missing(driver, &params, catalog).await;
    let found = match rows(driver, &params, catalog.sessions(), Vec::new()).await {
        Ok(found) => found,
        Err(_) if privilege.is_some() => Vec::new(),
        Err(error) => return Err(error),
    };
    let sessions = found
        .iter()
        .filter_map(|row| {
            Some(ServerSession {
                id: text(row, 0)?,
                user: text(row, 1),
                database: text(row, 2),
                application: text(row, 3),
                client: text(row, 4),
                state: text(row, 5),
                seconds: number(row, 6),
                wait: text(row, 7),
                sql: text(row, 8),
                own: flag(row, 9),
                active: flag(row, 10),
            })
        })
        .collect();
    Ok(SessionList {
        sessions,
        privilege,
    })
}

/// Who waits for whom.
pub async fn locks<D: Driver + ?Sized>(
    driver: &D,
    params: AdminParams,
    catalog: &dyn AdminCatalog,
) -> Result<LockList> {
    let privilege = missing(driver, &params, catalog).await;
    let found = match rows(driver, &params, catalog.locks(), Vec::new()).await {
        Ok(found) => found,
        Err(_) if privilege.is_some() => Vec::new(),
        Err(error) => return Err(error),
    };
    let waits = found
        .iter()
        .filter_map(|row| {
            Some(LockWait {
                waiting: text(row, 0)?,
                blocking: text(row, 1)?,
                object: text(row, 2),
                mode: text(row, 3),
                seconds: number(row, 4),
                waiting_user: text(row, 5),
                waiting_sql: text(row, 6),
                blocking_user: text(row, 7),
                blocking_sql: text(row, 8),
            })
        })
        .collect();
    Ok(LockList { waits, privilege })
}

/// Cancels the statement of a session or ends it. The asking session is the driver's own:
/// ending it from here is refused.
pub async fn kill<D: Driver + ?Sized>(
    driver: &D,
    params: KillParams,
    catalog: &dyn AdminCatalog,
) -> Result<Killed> {
    let asking = AdminParams {
        connection: params.connection.clone(),
        statement: params.statement.clone(),
    };
    let target = params.session.trim();
    let own = rows(driver, &asking, catalog.own(), Vec::new()).await?;
    if own.first().and_then(|row| text(row, 0)).as_deref() == Some(target) {
        return Err(DriverError::invalid(
            "This is Nexo's own session: it cannot be cancelled or ended from here",
        ));
    }
    let statement = catalog.kill(target, params.mode)?;
    let answer = rows(driver, &asking, statement.sql, statement.params).await?;
    let refused = matches!(
        answer.first().and_then(|row| row.first()),
        Some(Value::Bool(false))
    );
    Ok(Killed { done: !refused })
}
