//! Execution plans (`explain`): the plan of a statement in a form every engine shares (a tree
//! of nodes with their operation, object, index, condition, rows and cost, and in the actual
//! mode the rows and time measured) beside the plan as the engine wrote it.
//!
//! [`run`] is the way every driver answers it: the statements a [`PlanReader`] gives run on
//! the driver's own session with its own `execute`, and the reader turns the answer into
//! nodes with a pure function. The actual mode of a statement that writes runs inside a
//! transaction (or behind a savepoint) that always ends in a rollback.
mod run;
#[cfg(test)]
mod tests;

pub use run::run;

use crate::{Result, Value, statements::ExecuteResult};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

/// Estimated only plans; actual runs the statement to measure it.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ExplainMode {
    #[default]
    Estimated,
    Actual,
}

/// The plan of a statement of a session.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExplainParams {
    pub connection: String,
    /// The name of this run, to cancel it.
    pub statement: String,
    pub sql: String,
    #[serde(default)]
    pub params: Vec<Value>,
    #[serde(default)]
    pub mode: ExplainMode,
    /// The statement changes data: in the actual mode it runs in a transaction that is
    /// rolled back.
    #[serde(default)]
    pub writes: bool,
}

/// What a node of a plan says that the interface warns about.
pub mod flags {
    /// It reads a whole table.
    pub const FULL_SCAN: &str = "full-scan";
    /// It sorts on disk, out of memory.
    pub const DISK_SORT: &str = "disk-sort";
    /// It builds a temporary table.
    pub const TEMPORARY: &str = "temporary";
}

/// A node of a plan, in the form every engine shares.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct PlanNode {
    /// What it does: `Seq Scan`, `Hash Join`, `Clustered Index Seek`…
    pub operation: String,
    /// The table or view it reads.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub object: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub index: Option<String>,
    /// Its condition: a filter, the condition of a join or of an index.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub condition: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub estimated_rows: Option<f64>,
    /// The cost the engine estimated for it and what it holds, in its own units.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub estimated_cost: Option<f64>,
    /// Actual mode: the rows it gave in all its loops.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub actual_rows: Option<f64>,
    /// Actual mode: milliseconds it took, with what it holds.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub actual_ms: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub loops: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub memory_kb: Option<f64>,
    /// See [`flags`].
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub flags: Vec<String>,
    /// Anything else the engine said about it, by the engine's name.
    #[serde(skip_serializing_if = "BTreeMap::is_empty")]
    pub details: BTreeMap<String, String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub children: Vec<PlanNode>,
}

/// The plan of a statement.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Plan {
    pub mode: ExplainMode,
    /// The top nodes: one for most statements, one per statement of a batch.
    pub nodes: Vec<PlanNode>,
    /// `json`, `xml` or `text`: how `original` is written.
    pub format: String,
    /// The plan as the engine wrote it.
    pub original: String,
    /// Actual mode: milliseconds the whole statement took, as the engine measured it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total_ms: Option<f64>,
    /// Actual mode of a write: what it changed was rolled back.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub rolled_back: bool,
}

/// What a reader makes of the engine's answer.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct PlanRead {
    pub nodes: Vec<PlanNode>,
    pub format: &'static str,
    pub original: String,
    pub total_ms: Option<f64>,
}

/// The statements that give a plan: run in order on the session, `after` even when the
/// others fail (they undo what `before` set).
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Steps {
    pub before: Vec<String>,
    /// The statement whose answer holds the plan.
    pub plan: String,
    /// The values bound to it; `None` binds the statement's own.
    pub params: Option<Vec<Value>>,
    pub after: Vec<String>,
}

/// How one engine explains: its statements, and the pure reading of what it answers.
pub trait PlanReader: Send + Sync {
    /// The statements for the plan of `params.sql`; an engine without the mode says so.
    fn steps(&self, params: &ExplainParams) -> Result<Steps>;
    /// The plan in what the plan statement answered.
    fn read(&self, answer: &ExecuteResult, mode: ExplainMode) -> Result<PlanRead>;
}

/// The text of a column of an answer's rows (the first column when `column` is not found),
/// one line per row: where most engines put their plan.
pub fn text_of(columns: &[crate::Column], rows: &[Vec<Value>], column: Option<&str>) -> String {
    let at = column
        .and_then(|name| {
            columns
                .iter()
                .position(|each| each.name.eq_ignore_ascii_case(name))
        })
        .unwrap_or(0);
    rows.iter()
        .filter_map(|row| row.get(at))
        .map(|value| match value {
            Value::Text(text) | Value::Typed { text, .. } => text.clone(),
            Value::Integer(number) => number.to_string(),
            Value::Float(number) => number.to_string(),
            Value::Bool(value) => value.to_string(),
            Value::Null | Value::Array(_) => String::new(),
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// A number written as JSON number or text (`"12.5"`), as engines write them.
pub fn number(value: &serde_json::Value) -> Option<f64> {
    match value {
        serde_json::Value::Number(number) => number.as_f64(),
        serde_json::Value::String(text) => text.trim().parse().ok(),
        _ => None,
    }
}

/// The facts of a node of a JSON plan that are not mapped to [`PlanNode`]'s fields: every
/// scalar (and list of scalars) by its name, except `skip`.
pub fn details_of(
    node: &serde_json::Map<String, serde_json::Value>,
    skip: &[&str],
) -> BTreeMap<String, String> {
    let scalar = |value: &serde_json::Value| match value {
        serde_json::Value::String(text) => Some(text.clone()),
        serde_json::Value::Number(number) => Some(number.to_string()),
        serde_json::Value::Bool(value) => Some(value.to_string()),
        _ => None,
    };
    node.iter()
        .filter(|(name, _)| !skip.contains(&name.as_str()))
        .filter_map(|(name, value)| {
            let text = match value {
                serde_json::Value::Array(items) => {
                    let all: Option<Vec<String>> = items.iter().map(scalar).collect();
                    all.map(|all| all.join(", "))
                }
                other => scalar(other),
            }?;
            Some((name.clone(), text))
        })
        .collect()
}
