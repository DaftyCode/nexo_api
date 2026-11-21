//! Comparing two databases (DB-24): their structure, table by table and part by part, and
//! their data, row by row. These functions only read what the drivers describe; the
//! application reads both sides and writes what makes one like the other.
//!
//! Between two engines, column types are compared by what Nexo makes of them in the other
//! engine (as it copies a table there) or by the kind of values they hold, and marked
//! «equivalent» rather than «equal»; values are compared with the normalization of
//! [`values::canonical`].
mod pairs;
mod tables;
mod types;
mod values;

#[cfg(test)]
mod tests;

pub use tables::compare_tables;
pub use types::{Status, kind_of, type_status};
pub use values::{canonical, literal, timestamp};

use super::Dialect;
use serde::Serialize;
use serde_json::Value;

/// What a difference is about.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Part {
    /// The table itself: its comment or the order of its columns.
    Table,
    Column,
    PrimaryKey,
    Unique,
    Check,
    ForeignKey,
    Index,
}

/// A part that is only on one side or not the same on both: which fields of it differ, and
/// the part as each side has it.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Difference {
    pub part: Part,
    pub name: String,
    pub status: Status,
    pub fields: Vec<&'static str>,
    pub source: Value,
    pub target: Value,
}

impl Difference {
    fn new(
        part: Part,
        name: &str,
        status: Status,
        fields: Vec<&'static str>,
        source: &Value,
        target: &Value,
    ) -> Self {
        Self {
            part,
            name: name.to_string(),
            status,
            fields,
            source: source.clone(),
            target: target.clone(),
        }
    }
}

/// What a comparison of structure leaves out, and the engines of both sides.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Options {
    pub ignore_comments: bool,
    pub ignore_column_order: bool,
    /// Constraints and indexes are paired by what they hold, not by name (names the engine
    /// generates differ between two databases).
    pub ignore_constraint_names: bool,
    pub source: Dialect,
    pub target: Dialect,
}

impl Options {
    /// Two engines: names are matched without case and types by what they hold.
    pub fn between(&self) -> bool {
        self.source != self.target
    }
}

/// The definition of a view, routine or other object as compared: without comments, quotes
/// of names, case outside strings, the schema it is in, or differences of spacing.
pub fn definition(text: &str, schema: Option<&str>) -> String {
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    let mut quoted = false;
    while let Some(c) = chars.next() {
        match c {
            '\'' => {
                quoted = !quoted;
                out.push(c);
            }
            _ if quoted => out.push(c),
            '-' if chars.peek() == Some(&'-') => {
                for next in chars.by_ref() {
                    if next == '\n' {
                        break;
                    }
                }
                out.push(' ');
            }
            '"' | '`' | '[' | ']' => {}
            c if c.is_whitespace() => out.push(' '),
            c => out.extend(c.to_lowercase()),
        }
    }
    let mut normalized = out.split_whitespace().collect::<Vec<_>>().join(" ");
    if let Some(schema) = schema.filter(|schema| !schema.is_empty()) {
        normalized = normalized.replace(&format!("{}.", schema.to_lowercase()), "");
    }
    normalized.trim_end_matches(';').trim().to_string()
}
