//! Rows changed from the data grid (`rows.write`): the statements of each change, built for
//! the driver's dialect with bound values and quoted names, and run as one transaction (or,
//! inside one already open, behind a savepoint) in which every `UPDATE` and `DELETE` must
//! change exactly one row. Every driver has it through [`crate::Driver::rows_write`].
mod build;
#[cfg(test)]
mod tests;
mod write;

pub use build::{Built, statements};
pub use write::write;

use crate::Value;
use serde::{Deserialize, Serialize};

fn null() -> Value {
    Value::Null
}

/// The value of a column in a change, or its default.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Cell {
    pub column: String,
    #[serde(default = "null")]
    pub value: Value,
    /// The column takes its default instead of `value`.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub default: bool,
}

/// A change of a row: the key names it; `original` holds the values it had when read, for
/// optimistic locking.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase", deny_unknown_fields)]
pub enum RowChange {
    Insert {
        values: Vec<Cell>,
    },
    Update {
        key: Vec<Cell>,
        values: Vec<Cell>,
        #[serde(default)]
        original: Vec<Cell>,
    },
    Delete {
        key: Vec<Cell>,
        #[serde(default)]
        original: Vec<Cell>,
    },
}

/// Changes to write to one table of a connection.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RowsWriteParams {
    pub connection: String,
    #[serde(default)]
    pub schema: Option<String>,
    pub table: String,
    pub changes: Vec<RowChange>,
    /// Also compare the original values of what changed, not to overwrite another's change.
    #[serde(default)]
    pub optimistic: bool,
}

/// What a write did: the rows it changed and its statements, without their values.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct RowsWritten {
    pub affected: u64,
    pub statements: Vec<String>,
}
