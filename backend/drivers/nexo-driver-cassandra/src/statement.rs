//! CQL statements: bound to their parameters as the prepared statement says their types,
//! read page after page with the driver's paging state (the cursor `fetch` follows), with the
//! warnings of the server as notices.
use crate::values::{column, from_cql, to_cql};
use crate::{commands::Settings, connection::failure};
use nexo_driver_sdk::{
    Column, DriverError, Result, Value, limits,
    statements::{ExecuteResult, Notice},
};
use scylla::{
    client::session::Session,
    response::{PagingState, PagingStateResponse, query_result::QueryResult},
    statement::{Statement, prepared::PreparedStatement},
    value::{CqlValue, Row},
};
use std::ops::ControlFlow;

/// What a cursor runs again for its next page.
#[derive(Clone)]
pub(crate) enum Query {
    Plain(Statement),
    Prepared(PreparedStatement, Vec<Option<CqlValue>>),
}

/// A statement whose rows go on: what it runs and where it stopped.
pub(crate) struct Cursor {
    pub query: Query,
    pub paging: PagingState,
}

/// The statement of `sql` with its values bound by the types the server expects, run with
/// the level and the tracing of the session.
pub(crate) async fn query(
    session: &Session,
    sql: &str,
    params: &[Value],
    settings: &Settings,
) -> Result<Query> {
    if params.is_empty() {
        let mut statement = Statement::new(sql);
        if let Some(level) = settings.consistency {
            statement.set_consistency(level);
        }
        statement.set_tracing(settings.tracing);
        return Ok(Query::Plain(statement));
    }
    let mut prepared = session.prepare(sql).await.map_err(failure)?;
    if let Some(level) = settings.consistency {
        prepared.set_consistency(level);
    }
    prepared.set_tracing(settings.tracing);
    let specs = prepared.get_variable_col_specs();
    if specs.len() != params.len() {
        return Err(DriverError::invalid(format!(
            "The statement has {} markers and {} values",
            specs.len(),
            params.len()
        )));
    }
    let values = specs
        .iter()
        .zip(params)
        .map(|(spec, value)| to_cql(value, spec.typ()))
        .collect::<Result<Vec<_>>>()?;
    Ok(Query::Prepared(prepared, values))
}

/// One page of a statement, from where it stopped.
pub(crate) async fn page(
    session: &Session,
    query: &Query,
    paging: PagingState,
    rows: u32,
) -> Result<(QueryResult, Option<PagingState>)> {
    let size = i32::try_from(rows.clamp(1, limits::MAX_PAGE_ROWS)).unwrap_or(i32::MAX);
    let (result, next): (QueryResult, PagingStateResponse) = match query {
        Query::Plain(statement) => {
            let mut statement = statement.clone();
            statement.set_page_size(size);
            session.query_single_page(statement, (), paging).await
        }
        Query::Prepared(prepared, values) => {
            let mut prepared = prepared.clone();
            prepared.set_page_size(size);
            session.execute_single_page(&prepared, values, paging).await
        }
    }
    .map_err(failure)?;
    let next = match next.into_paging_control_flow() {
        ControlFlow::Continue(state) => Some(state),
        ControlFlow::Break(()) => None,
    };
    Ok((result, next))
}

/// The columns, rows and notices of an answer; a statement without rows has none.
type Answer = (Vec<Column>, Vec<Vec<Value>>, Vec<Notice>);

pub(crate) fn read(result: QueryResult) -> Result<Answer> {
    let notices: Vec<Notice> = result
        .warnings()
        .map(|warning| Notice {
            severity: "warning".into(),
            message: warning.to_owned(),
        })
        .collect();
    if !result.is_rows() {
        return Ok((Vec::new(), Vec::new(), notices));
    }
    let result = result.into_rows_result().map_err(failure)?;
    let columns = result
        .column_specs()
        .iter()
        .map(|spec| column(spec.name(), spec.typ()))
        .collect();
    let rows = result
        .rows::<Row>()
        .map_err(failure)?
        .map(|row| {
            row.map(|row| {
                row.columns
                    .iter()
                    .map(|value| from_cql(value.as_ref()))
                    .collect()
            })
        })
        .collect::<std::result::Result<_, _>>()
        .map_err(failure)?;
    Ok((columns, rows, notices))
}

/// The events of a traced statement, as `TRACING ON` shows them in cqlsh.
pub(crate) async fn trace(session: &Session, result: &QueryResult) -> Vec<Notice> {
    let Some(id) = result.tracing_id() else {
        return Vec::new();
    };
    let Ok(info) = session.get_tracing_info(&id).await else {
        return vec![Notice {
            severity: "warning".into(),
            message: format!("The trace {id} was not ready: read it from system_traces"),
        }];
    };
    let mut notices: Vec<Notice> = info
        .events
        .iter()
        .take(TRACE_EVENTS)
        .map(|event| Notice {
            severity: "info".into(),
            message: format!(
                "{} [{}] {} \u{b5}s: {}",
                event.source.map(|ip| ip.to_string()).unwrap_or_default(),
                event.thread.as_deref().unwrap_or_default(),
                event.source_elapsed.unwrap_or_default(),
                event.activity.as_deref().unwrap_or_default()
            ),
        })
        .collect();
    notices.push(Notice {
        severity: "info".into(),
        message: format!(
            "Trace {id}: {} \u{b5}s on {}",
            info.duration.unwrap_or_default(),
            info.coordinator
                .map(|ip| ip.to_string())
                .unwrap_or_default()
        ),
    });
    notices
}

/// The events of a trace shown at most.
const TRACE_EVENTS: usize = 200;

/// The answer of `execute`, its cursor named by the caller.
pub(crate) fn answer(
    result: QueryResult,
    cursor: Option<String>,
    elapsed_ms: u64,
) -> Result<ExecuteResult> {
    let (columns, rows, notices) = read(result)?;
    Ok(ExecuteResult {
        columns,
        rows,
        cursor,
        // CQL does not say how many rows a write changed.
        affected: None,
        notices,
        elapsed_ms,
        results: Vec::new(),
    })
}
