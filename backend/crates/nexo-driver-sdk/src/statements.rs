//! Messages about statements: running one, reading its pages, cancelling it, and the
//! transaction it belongs to.
use crate::{Column, Value};
use serde::{Deserialize, Serialize};

/// One statement to run. Values are always bound, never written into the text.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExecuteParams {
    pub connection: String,
    /// The name the host gives this run, to cancel it while it is still running.
    pub statement: String,
    pub sql: String,
    #[serde(default)]
    pub params: Vec<Value>,
    /// Rows in each page; the driver never answers more than its limits allow.
    #[serde(default)]
    pub page_rows: Option<u32>,
    /// Rows read in all, over every page.
    #[serde(default)]
    pub max_rows: Option<u64>,
}

/// What a statement answered: its first page and, when there are more rows, the cursor
/// that reads them.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ExecuteResult {
    /// Empty when the statement returns no rows.
    pub columns: Vec<Column>,
    pub rows: Vec<Vec<Value>>,
    pub cursor: Option<String>,
    /// Rows a write changed.
    pub affected: Option<u64>,
    /// What the server said besides the result: warnings, `NOTICE`, `PRINT`.
    pub notices: Vec<Notice>,
    pub elapsed_ms: u64,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Notice {
    /// `info`, `warning` or `error`.
    pub severity: String,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FetchParams {
    pub connection: String,
    pub cursor: String,
    #[serde(default)]
    pub page_rows: Option<u32>,
}
/// The next rows of a cursor. Without `cursor`, they were the last ones and it is closed.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Page {
    pub rows: Vec<Vec<Value>>,
    pub cursor: Option<String>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CursorParams {
    pub connection: String,
    pub cursor: String,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CancelParams {
    pub connection: String,
    pub statement: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TransactionAction {
    /// Only reads the state.
    Status,
    Begin,
    Commit,
    Rollback,
    /// Every statement is its own transaction.
    Auto,
    /// Statements wait for a commit or a rollback.
    Manual,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TransactionParams {
    pub connection: String,
    pub action: TransactionAction,
    /// `read committed`, `serializable`… from the ones the engine has.
    #[serde(default)]
    pub isolation: Option<String>,
}
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct TransactionState {
    pub auto_commit: bool,
    /// There is something to commit or roll back.
    pub open: bool,
}
