//! Execution plans of MySQL and MariaDB, read into the shared form of
//! [`nexo_driver_sdk::explain`]:
//!
//! - MySQL: `EXPLAIN FORMAT=JSON` estimates and, from 8.3, `EXPLAIN ANALYZE FORMAT=JSON` with
//!   the iterator format (`explain_json_format_version = 2`) measures a query. It measures no
//!   single-table change, so its actual mode is only for queries.
//! - MariaDB: `EXPLAIN FORMAT=JSON` estimates and `ANALYZE FORMAT=JSON` runs any statement to
//!   measure it (a change, inside the transaction the SDK rolls back).
mod blocks;
mod iterators;
#[cfg(test)]
mod tests;

use crate::connection::Server;
use nexo_driver_sdk::{
    DriverError, Result,
    explain::{ExplainMode, ExplainParams, PlanRead, PlanReader, Steps, text_of},
    statements::ExecuteResult,
};
use serde_json::Value as Json;

pub struct MysqlPlans {
    pub server: Server,
}

impl PlanReader for MysqlPlans {
    fn steps(&self, params: &ExplainParams) -> Result<Steps> {
        let sql = params.sql.trim().trim_end_matches(';').trim_end();
        let mariadb = self.server.mariadb;
        Ok(match params.mode {
            ExplainMode::Estimated => Steps {
                plan: format!("EXPLAIN FORMAT=JSON {sql}"),
                ..Steps::default()
            },
            ExplainMode::Actual if mariadb => Steps {
                plan: format!("ANALYZE FORMAT=JSON {sql}"),
                ..Steps::default()
            },
            ExplainMode::Actual if self.server.at_least(8, 3) => Steps {
                before: vec!["SET SESSION explain_json_format_version = 2".into()],
                plan: format!("EXPLAIN ANALYZE FORMAT=JSON {sql}"),
                after: vec!["SET SESSION explain_json_format_version = DEFAULT".into()],
                params: None,
            },
            ExplainMode::Actual => {
                return Err(DriverError::unsupported(
                    "The actual plan needs MySQL 8.3 or later: this server only estimates",
                ));
            }
        })
    }

    fn read(&self, answer: &ExecuteResult, _mode: ExplainMode) -> Result<PlanRead> {
        read(&text_of(&answer.columns, &answer.rows, Some("EXPLAIN")))
    }
}

/// The plan of what `EXPLAIN FORMAT=JSON` (or `ANALYZE`) wrote, in either format.
pub fn read(original: &str) -> Result<PlanRead> {
    let unreadable = || DriverError::internal("The server answered a plan Nexo cannot read");
    let json: Json = serde_json::from_str(original).map_err(|_| unreadable())?;
    let top = json.as_object().ok_or_else(unreadable)?;
    let (nodes, total_ms) = if top.contains_key("query_block") {
        blocks::read(top)
    } else if top.contains_key("operation") {
        if top["operation"]
            .as_str()
            .is_some_and(|operation| operation.starts_with("<not executable"))
        {
            return Err(DriverError::unsupported(
                "MySQL measures only queries: explain this change without running it",
            ));
        }
        iterators::read(top)
    } else {
        return Err(unreadable());
    };
    Ok(PlanRead {
        nodes,
        format: "json",
        original: original.to_owned(),
        total_ms,
    })
}
