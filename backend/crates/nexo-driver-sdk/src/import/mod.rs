//! Rows imported into a table (`import`): a batch of rows from a file or from another
//! connection, written with bound values by the driver's own `execute`. Every driver has it
//! through [`crate::Driver::import`].
//!
//! - Going on after failures, each row goes behind a savepoint: a failed row is undone alone
//!   and said with its position and why.
//! - Stopping at the first failure, the rows go in multi-row `INSERT`s and the first failure
//!   undoes the whole batch: nothing is left half done.
//! - The batch is its own transaction in auto-commit; inside a transaction already open (one
//!   import as a single transaction, or manual commit) it goes behind a savepoint instead.
mod build;
#[cfg(test)]
mod tests;
mod write;

pub use build::{insert, upsert};
pub use write::write;

use crate::Value;
use serde::{Deserialize, Serialize};

/// Rows a batch fails with, at most, said one by one; the others are only counted.
pub const FAILURES_KEPT: usize = 100;

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ImportMode {
    #[default]
    Insert,
    /// Inserts, or updates the row with the same key (`ON CONFLICT`, `ON DUPLICATE KEY`,
    /// `MERGE`).
    Upsert,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ImportParams {
    pub connection: String,
    #[serde(default)]
    pub schema: Option<String>,
    pub table: String,
    pub columns: Vec<String>,
    pub rows: Vec<Vec<Value>>,
    #[serde(default)]
    pub mode: ImportMode,
    /// The columns that name a row, for `upsert`.
    #[serde(default)]
    pub key: Vec<String>,
    #[serde(default)]
    pub stop_on_error: bool,
    /// The position of the batch's first row in the whole import (1 for the very first).
    #[serde(default = "first")]
    pub first: u64,
}
fn first() -> u64 {
    1
}

/// A row that was not written.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportFailure {
    pub position: u64,
    /// When a multi-row statement failed: the last row it held.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last: Option<u64>,
    pub message: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Imported {
    pub inserted: u64,
    /// Rows inserted or updated by their key.
    pub upserted: u64,
    pub failed: u64,
    pub failures: Vec<ImportFailure>,
    /// The batch stopped at a failure and wrote nothing.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub stopped: bool,
}
