//! The objects of a SQLite file as DBeaver shows them, read from `sqlite_schema` and from the
//! pragmas as table functions, with their values bound.
//!
//! Paths: `[folder]` and `[folder, name]`, where a folder is `tables`, `views`, `indexes` or
//! `triggers`; and `[tables | views, name, part]` and `[…, part, item]`, where a part is
//! `columns`, `foreign-keys`, `indexes`, `references` or `triggers`. A file has one database:
//! the tree has no level for it.
//! Adapted in part from DBeaver (Apache-2.0): plugins/org.jkiss.dbeaver.ext.sqlite.
pub(crate) mod ddl;
pub(crate) mod describe;
pub(crate) mod tree;

use crate::{connection::SqliteConnection, session::Rows};
use nexo_driver_sdk::{
    DriverError, Result, Value,
    protocol::{Property, Section, TreeNode},
};

pub(crate) fn node(
    kind: &str,
    name: &str,
    detail: Option<String>,
    children: bool,
    actions: &[&str],
) -> TreeNode {
    TreeNode {
        kind: kind.into(),
        name: name.into(),
        label: name.into(),
        detail: detail.filter(|detail| !detail.is_empty()),
        has_children: children,
        actions: actions.iter().map(|action| (*action).into()).collect(),
        system: false,
    }
}

pub(crate) fn folders(list: &[(&str, &str)]) -> Vec<TreeNode> {
    list.iter()
        .map(|(id, label)| TreeNode {
            label: (*label).into(),
            ..node("folder", id, None, true, &[])
        })
        .collect()
}

pub(crate) fn unknown() -> DriverError {
    DriverError::invalid("There is no such object")
}

/// The text of a cell; `NULL` as empty, numbers as text, for names and details.
pub(crate) fn text(row: &[Value], index: usize) -> String {
    match row.get(index) {
        Some(Value::Text(text)) => text.clone(),
        Some(Value::Integer(number)) => number.to_string(),
        Some(Value::Typed { text, .. }) => text.clone(),
        _ => String::new(),
    }
}

/// Runs a catalog query with its values bound in order.
pub(crate) async fn query(
    connection: &SqliteConnection,
    sql: &str,
    params: &[&str],
) -> Result<Rows> {
    let params = params
        .iter()
        .map(|value| Value::Text((*value).to_owned()))
        .collect();
    connection.query(sql, params).await
}

/// A section of a description: the columns and rows of a query.
pub(crate) fn section(id: &str, title: &str, rows: Rows) -> Section {
    Section {
        id: id.into(),
        title: title.into(),
        columns: rows.columns,
        rows: rows.rows,
    }
}

/// The first row of a query as properties, by its columns' names; empty values left out.
pub(crate) fn properties(rows: &Rows) -> Vec<Property> {
    let Some(row) = rows.rows.first() else {
        return Vec::new();
    };
    rows.columns
        .iter()
        .zip(row)
        .filter(|(_, value)| !matches!(value, Value::Null))
        .map(|(name, value)| Property {
            name: name.clone(),
            value: value.clone(),
        })
        .collect()
}

/// The module of a virtual table, from the statement that made it (`… USING fts5(…)`).
pub(crate) fn module_of(sql: &str) -> Option<String> {
    let upper = sql.to_ascii_uppercase();
    let at = upper.find(" USING ")? + " USING ".len();
    let module: String = sql[at..]
        .trim_start()
        .chars()
        .take_while(|c| c.is_ascii_alphanumeric() || *c == '_')
        .collect();
    (!module.is_empty()).then_some(module)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_module_of_a_virtual_table() {
        assert_eq!(
            module_of("CREATE VIRTUAL TABLE docs USING fts5(title, body)").as_deref(),
            Some("fts5")
        );
        assert_eq!(module_of("CREATE TABLE t (a)"), None);
    }
}
