//! Execution plans of SQL Server: `SET SHOWPLAN_XML ON` estimates without running; `SET
//! STATISTICS XML ON` runs the statement and adds its measured plan as one more result. Both
//! are XML showplans, read into the shared form of [`nexo_driver_sdk::explain`].
mod relop;
#[cfg(test)]
mod tests;
mod xml;

use crate::session::RESULTS;
use nexo_driver_sdk::{
    DriverError, Result, Value,
    explain::{ExplainMode, ExplainParams, PlanRead, PlanReader, Steps, text_of},
    statements::ExecuteResult,
};

pub struct SqlServerPlans;

/// The column SQL Server names its showplans with (from 2005 on).
const SHOWPLAN: &str = "XML Showplan";

/// `DECLARE @P1 bigint, @P2 nvarchar(4000);` for the values a statement binds, with the
/// types the driver binds them with.
fn declared(params: &[Value]) -> String {
    if params.is_empty() {
        return String::new();
    }
    let types: Vec<String> = params
        .iter()
        .enumerate()
        .map(|(at, value)| {
            let kind = match value {
                Value::Bool(_) => "bit",
                Value::Integer(_) => "bigint",
                Value::Float(_) => "float",
                _ => "nvarchar(4000)",
            };
            format!("@P{} {kind}", at + 1)
        })
        .collect();
    format!("DECLARE {};\n", types.join(", "))
}

impl PlanReader for SqlServerPlans {
    fn steps(&self, params: &ExplainParams) -> Result<Steps> {
        let sql = params.sql.trim();
        // A change is read as a batch with results: its plan is one of them.
        Ok(match params.mode {
            // A planned batch runs nothing, so its values cannot be bound (`sp_executesql`
            // would not run either): its parameters are declared by type, as unknown values.
            ExplainMode::Estimated => Steps {
                before: vec!["SET SHOWPLAN_XML ON".into()],
                plan: format!("{RESULTS}\n{}{sql}", declared(&params.params)),
                params: Some(Vec::new()),
                after: vec!["SET SHOWPLAN_XML OFF".into()],
            },
            ExplainMode::Actual => Steps {
                before: vec!["SET STATISTICS XML ON".into()],
                plan: format!("{RESULTS}\n{sql}"),
                params: None,
                after: vec!["SET STATISTICS XML OFF".into()],
            },
        })
    }

    fn read(&self, answer: &ExecuteResult, _mode: ExplainMode) -> Result<PlanRead> {
        let first = std::iter::once((&answer.columns, &answer.rows));
        let further = answer.results.iter().map(|set| (&set.columns, &set.rows));
        let plans: Vec<String> = first
            .chain(further)
            .filter(|(columns, _)| {
                columns
                    .first()
                    .is_some_and(|column| column.name.contains(SHOWPLAN))
            })
            .map(|(columns, rows)| text_of(columns, rows, None))
            .collect();
        if plans.is_empty() && answer.cursor.is_some() {
            return Err(DriverError::invalid(
                "SQL Server sends the measured plan after every row, and the query returns too many: limit it with TOP or explain it estimated",
            ));
        }
        read(&plans.join("\n"))
    }
}

/// The plan of one or more XML showplans, one per line.
pub fn read(original: &str) -> Result<PlanRead> {
    let unreadable = || DriverError::internal("SQL Server answered a plan Nexo cannot read");
    let mut nodes = Vec::new();
    let mut total_ms = None;
    for document in original.lines().filter(|line| !line.trim().is_empty()) {
        let plan = xml::parse(document).ok_or_else(unreadable)?;
        if plan.name != "ShowPlanXML" {
            return Err(unreadable());
        }
        let (statements, ms) = relop::statements(&plan);
        nodes.extend(statements);
        if let Some(ms) = ms {
            *total_ms.get_or_insert(0.0) += ms;
        }
    }
    if nodes.is_empty() {
        return Err(unreadable());
    }
    Ok(PlanRead {
        nodes,
        format: "xml",
        original: original.to_owned(),
        total_ms,
    })
}
