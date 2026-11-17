//! The objects of a SQL Server as DBeaver shows them, read from the catalog views of each
//! database (`[db].sys.*`, so no `USE` is needed).
//!
//! Paths: `["databases", db]`, `[…, "schemas", schema]`, `[…, schema, folder, name]` and
//! `[…, name, part, item]`, where a folder is `tables`, `views`, `procedures`… and a part is
//! `columns`, `constraints`, `indexes`…; and `["security", …]`, `["administration", …]` for
//! the server. Indexes are named by `object:index` ids, since their names repeat.
//! Adapted in part from DBeaver (Apache-2.0): plugins/org.jkiss.dbeaver.ext.mssql/model.
pub(crate) mod ddl;
pub(crate) mod describe;
mod security;
pub(crate) mod tree;

use crate::{connection::MsConnection, dialect::quoted, session::Rows};
use nexo_driver_sdk::{
    DriverError, Result, Value,
    protocol::{Property, Section, TreeNode},
};

/// Folders of a schema: their id, label and the kind of their objects.
pub(crate) const SCHEMA_FOLDERS: [(&str, &str, &str); 9] = [
    ("tables", "Tables", "table"),
    ("views", "Views", "view"),
    ("indexes", "Indexes", "index"),
    ("procedures", "Procedures", "procedure"),
    ("functions", "Functions", "function"),
    ("sequences", "Sequences", "sequence"),
    ("synonyms", "Synonyms", "synonym"),
    ("types", "Types", "type"),
    ("triggers", "Triggers", "trigger"),
];

/// The type of a column as SQL Server writes it (`nvarchar(40)`, `decimal(12,2)`), from
/// `c` (`sys.columns`) and `ty` (`sys.types`).
pub(crate) const COLUMN_TYPE: &str = "ty.name + CASE \
    WHEN ty.is_user_defined = 1 THEN '' \
    WHEN ty.name IN ('varchar', 'char', 'varbinary', 'binary') THEN '(' + CASE WHEN c.max_length = -1 THEN 'max' ELSE CAST(c.max_length AS varchar(10)) END + ')' \
    WHEN ty.name IN ('nvarchar', 'nchar') THEN '(' + CASE WHEN c.max_length = -1 THEN 'max' ELSE CAST(c.max_length / 2 AS varchar(10)) END + ')' \
    WHEN ty.name IN ('decimal', 'numeric') THEN '(' + CAST(c.precision AS varchar(10)) + ',' + CAST(c.scale AS varchar(10)) + ')' \
    WHEN ty.name IN ('datetime2', 'time', 'datetimeoffset') THEN '(' + CAST(c.scale AS varchar(10)) + ')' \
    ELSE '' END";

/// The id of the object `@P1`.`@P2` of database `db`.
pub(crate) fn object(db: &str) -> String {
    format!(
        "(SELECT o.object_id FROM {db}.sys.objects o JOIN {db}.sys.schemas s ON s.schema_id = o.schema_id \
         WHERE s.name = @P1 AND o.name = @P2)"
    )
}

/// A database of a path, quoted for a three-part name.
pub(crate) fn database(name: &str) -> String {
    quoted(name)
}

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

pub(crate) fn unknown() -> DriverError {
    DriverError::invalid("There is no such object")
}

/// The text of a cell; `NULL` and numbers as text, for names and details.
pub(crate) fn text(row: &[Value], index: usize) -> String {
    match row.get(index) {
        Some(Value::Text(text)) => text.clone(),
        Some(Value::Integer(number)) => number.to_string(),
        Some(Value::Bool(value)) => value.to_string(),
        Some(Value::Typed { text, .. }) => text.clone(),
        _ => String::new(),
    }
}

/// Runs a catalog query with the schema and name of an object as its parameters.
pub(crate) async fn query(connection: &MsConnection, sql: &str, params: &[&str]) -> Result<Rows> {
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
