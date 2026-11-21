//! What both sides of a comparison of data read, and the statements that read them.
use super::super::Side;
use crate::payloads::CompareTable;
use nexo_domain::sql::{Dialect, compare::canonical, quote};
use serde_json::Value;

/// What both sides read: their tables, key and compared columns, with their names on each side.
pub(super) struct Plan {
    pub source: Side,
    pub target: Side,
    pub source_table: String,
    pub target_table: String,
    pub target_ref: CompareTable,
    pub key: Vec<(String, String)>,
    pub columns: Vec<(String, String)>,
    pub filter: String,
    pub statement: String,
    pub between: bool,
}

/// A parameter of a statement as the engine writes it: `$1`, `?` or `@P1`.
fn placeholder(dialect: Dialect, at: usize) -> String {
    match dialect {
        Dialect::PostgreSql => format!("${at}"),
        Dialect::TSql => format!("@P{at}"),
        _ => "?".into(),
    }
}

/// `schema.table` as the engine quotes it.
pub(super) fn qualified(table: &CompareTable, dialect: Dialect) -> String {
    match table.schema.as_deref().filter(|schema| !schema.is_empty()) {
        Some(schema) => format!(
            "{}.{}",
            quote(schema, dialect),
            quote(&table.table, dialect)
        ),
        None => quote(&table.table, dialect),
    }
}

pub(super) fn names(model: &Value) -> Vec<String> {
    model["columns"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|c| c["name"].as_str().map(String::from))
        .collect()
}

impl Plan {
    fn list(&self, columns: &[(String, String)], source: bool) -> String {
        let dialect = if source {
            self.source.dialect
        } else {
            self.target.dialect
        };
        columns
            .iter()
            .map(|(a, b)| quote(if source { a } else { b }, dialect))
            .collect::<Vec<_>>()
            .join(", ")
    }

    /// The columns read from a side: its key, then the compared ones.
    fn read(&self, source: bool) -> String {
        let all: Vec<(String, String)> = self.key.iter().chain(&self.columns).cloned().collect();
        self.list(&all, source)
    }

    /// Every row of a side by its key, with the filter.
    pub fn scan(&self, source: bool) -> String {
        let table = if source {
            &self.source_table
        } else {
            &self.target_table
        };
        let filter = if self.filter.is_empty() {
            String::new()
        } else {
            format!(" WHERE ({})", self.filter)
        };
        format!(
            "SELECT {} FROM {table}{filter} ORDER BY {}",
            self.read(source),
            self.list(&self.key, source)
        )
    }

    /// The rows of a side whose key is one of `keys` (`full`: all the columns read).
    pub fn lookup(&self, source: bool, keys: &[Vec<Value>], full: bool) -> (String, Vec<Value>) {
        let dialect = if source {
            self.source.dialect
        } else {
            self.target.dialect
        };
        let table = if source {
            &self.source_table
        } else {
            &self.target_table
        };
        let mut params = Vec::new();
        let mut mark = |value: &Value| {
            params.push(value.clone());
            placeholder(dialect, params.len())
        };
        let name = |(a, b): &(String, String)| quote(if source { a } else { b }, dialect);
        // One column: `IN (…)`; several: each key's columns, joined with `OR`.
        let condition = if self.key.len() == 1 {
            let marks: Vec<String> = keys.iter().map(|key| mark(&key[0])).collect();
            format!("{} IN ({})", name(&self.key[0]), marks.join(", "))
        } else {
            keys.iter()
                .map(|key| {
                    let parts: Vec<String> = self
                        .key
                        .iter()
                        .zip(key)
                        .map(|(column, value)| format!("{} = {}", name(column), mark(value)))
                        .collect();
                    format!("({})", parts.join(" AND "))
                })
                .collect::<Vec<_>>()
                .join(" OR ")
        };
        let read = if full {
            self.read(source)
        } else {
            self.list(&self.key, source)
        };
        (
            format!("SELECT {read} FROM {table} WHERE {condition}"),
            params,
        )
    }

    /// The canonical text of a key, to pair rows of both sides.
    pub fn key_text(&self, key: &[Value]) -> String {
        key.iter()
            .map(|value| canonical(value, self.between))
            .collect::<Vec<_>>()
            .join("\u{1f}")
    }
}
