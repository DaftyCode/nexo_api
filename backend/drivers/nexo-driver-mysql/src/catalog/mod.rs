//! The objects of a MySQL or MariaDB server as DBeaver shows them, read from
//! `information_schema` (with parameters) and from `SHOW` statements (with quoted names).
//!
//! Paths: `["databases", db]`, `[…, db, folder, name]` and `[…, name, part, item]`, where a
//! folder is `tables`, `views`, `procedures`… and a part is `columns`, `constraints`,
//! `indexes`…; and `["users", "user@host"]`, `["administration", …]` for the server. The
//! database's own indexes are named `table.index`, since their names repeat.
//! Adapted in part from DBeaver (Apache-2.0): plugins/org.jkiss.dbeaver.ext.mysql/model.
pub(crate) mod ddl;
pub(crate) mod describe;
pub(crate) mod tree;

use crate::{connection::MyConnection, session::Rows};
use nexo_driver_sdk::{
    DriverError, Result, Value,
    protocol::{Property, Section, TreeNode},
};

/// The databases MySQL and MariaDB keep for themselves: the simple view hides them.
pub(crate) const SYSTEM_DATABASES: [&str; 4] =
    ["mysql", "information_schema", "performance_schema", "sys"];

pub(crate) fn node(
    kind: &str,
    name: &str,
    label: &str,
    detail: Option<String>,
    children: bool,
    actions: &[&str],
) -> TreeNode {
    TreeNode {
        kind: kind.into(),
        name: name.into(),
        label: label.into(),
        detail,
        has_children: children,
        actions: actions.iter().map(|action| (*action).into()).collect(),
        system: false,
    }
}

/// Folders, those named in `system` hidden by the simple view.
pub(crate) fn folders(list: &[(&str, &str)], system: &[&str]) -> Vec<TreeNode> {
    list.iter()
        .map(|(id, label)| TreeNode {
            system: system.contains(id),
            ..node("folder", id, label, None, true, &[])
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
        Some(Value::Bool(value)) => value.to_string(),
        Some(Value::Typed { text, .. }) => text.clone(),
        _ => String::new(),
    }
}

/// Runs a catalog query with its values bound in order.
pub(crate) async fn query(connection: &MyConnection, sql: &str, params: &[&str]) -> Result<Rows> {
    let params = params
        .iter()
        .map(|value| Value::Text((*value).to_owned()))
        .collect();
    connection.query(sql, params).await
}

/// Rows of a query as nodes: name in the first column, label in the second (or the name),
/// detail in the last.
pub(crate) fn listed(
    rows: Rows,
    kind: &str,
    children: bool,
    actions: &[&str],
    labelled: bool,
) -> Vec<TreeNode> {
    rows.rows
        .iter()
        .map(|row| {
            let name = text(row, 0);
            let label = if labelled { text(row, 1) } else { name.clone() };
            let detail = Some(text(row, row.len() - 1))
                .filter(|detail| !detail.is_empty() && row.len() > 1 + labelled as usize);
            node(kind, &name, &label, detail, children, actions)
        })
        .collect()
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

/// A user of a path (`name@host`) as MySQL names it: `'name'@'host'`.
pub(crate) fn account(path: &str) -> Result<String> {
    let (name, host) = path.rsplit_once('@').ok_or_else(unknown)?;
    Ok(format!(
        "{}@{}",
        crate::dialect::literal(name),
        crate::dialect::literal(host)
    ))
}

/// The columns of a key, in order, joined as the interface reads them.
pub(crate) fn key_columns(referenced: bool) -> String {
    let column = if referenced {
        "k.REFERENCED_COLUMN_NAME"
    } else {
        "k.COLUMN_NAME"
    };
    format!(
        "(SELECT GROUP_CONCAT({column} ORDER BY k.ORDINAL_POSITION SEPARATOR ', ') \
         FROM information_schema.KEY_COLUMN_USAGE k WHERE k.CONSTRAINT_SCHEMA = rc.CONSTRAINT_SCHEMA \
         AND k.TABLE_NAME = rc.TABLE_NAME AND k.CONSTRAINT_NAME = rc.CONSTRAINT_NAME)"
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_an_account() {
        assert_eq!(account("ana@%").unwrap(), "'ana'@'%'");
        assert_eq!(account("a@b@localhost").unwrap(), "'a@b'@'localhost'");
        assert!(account("nobody").is_err());
    }
}
