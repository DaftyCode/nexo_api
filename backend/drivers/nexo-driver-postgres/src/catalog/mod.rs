//! The objects of a server as DBeaver shows them, read from `pg_catalog`.
//!
//! Paths: `[database]`, `[database, "schemas", schema]`,
//! `[database, "schemas", schema, folder, name]` and `[…, name, part, item]`, where a folder
//! is `tables`, `views`, `functions`… and a part is `columns`, `constraints`, `indexes`…
//! Functions, procedures and aggregates are named by their oid, since names repeat.
//! Adapted in part from DBeaver (Apache-2.0): plugins/org.jkiss.dbeaver.ext.postgresql/model.
pub(crate) mod ddl;
pub(crate) mod describe;
pub(crate) mod tree;

use crate::{connection::PgConnection, errors::database, values};
use nexo_driver_sdk::{
    DriverError, Result, Value,
    protocol::{Property, Section, TreeNode},
};
use tokio_postgres::{Client, Row, types::ToSql};

/// The oid of a relation of a schema, for queries that take `$1` schema and `$2` name.
pub(crate) const RELATION: &str = "(SELECT c.oid FROM pg_class c JOIN pg_namespace n \
    ON n.oid = c.relnamespace WHERE n.nspname = $1 AND c.relname = $2)";

/// Folders of a schema: their id, label, the `relkind`s they list (when relations) and the
/// kind of their objects.
pub(crate) const SCHEMA_FOLDERS: [(&str, &str, &str); 10] = [
    ("tables", "Tables", "table"),
    ("foreign-tables", "Foreign tables", "table"),
    ("views", "Views", "view"),
    ("materialized-views", "Materialized views", "view"),
    ("indexes", "Indexes", "index"),
    ("functions", "Functions", "function"),
    ("procedures", "Procedures", "procedure"),
    ("sequences", "Sequences", "sequence"),
    ("types", "Data types", "type"),
    ("aggregates", "Aggregates", "aggregate"),
];

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
    }
}

pub(crate) fn unknown() -> DriverError {
    DriverError::invalid("There is no such object")
}

/// Runs a catalog query.
pub(crate) async fn query(
    client: &Client,
    sql: &str,
    params: &[&(dyn ToSql + Sync)],
) -> Result<Vec<Row>> {
    client
        .query(sql, params)
        .await
        .map_err(|error| database(error, Some(sql)))
}

/// The text of a column of a row, empty when it is null.
pub(crate) fn text(row: &Row, index: usize) -> String {
    row.try_get::<_, Option<String>>(index)
        .ok()
        .flatten()
        .unwrap_or_default()
}

/// Every column of a row as a property, named as the query names it.
pub(crate) fn properties(row: &Row) -> Vec<Property> {
    row.columns()
        .iter()
        .zip(values::row(row))
        .filter(|(_, value)| *value != Value::Null)
        .map(|(column, value)| Property {
            name: column.name().to_owned(),
            value,
        })
        .collect()
}

/// A list of an object, with the columns its query names.
pub(crate) fn section(id: &str, title: &str, rows: &[Row]) -> Section {
    Section {
        id: id.into(),
        title: title.into(),
        columns: rows
            .first()
            .map(|row| {
                row.columns()
                    .iter()
                    .map(|column| column.name().to_owned())
                    .collect()
            })
            .unwrap_or_default(),
        rows: rows.iter().map(values::row).collect(),
    }
}

/// A partition is a table of its own: `[…, "tables", parent, "partitions", child, …]` is
/// `[…, "tables", child, …]`.
pub(crate) fn resolved(path: &[String]) -> Vec<String> {
    let mut path = path.to_vec();
    while path.len() >= 7 && path[3] == "tables" && path[5] == "partitions" {
        path.drain(4..6);
    }
    path
}

/// A path's database and the client that reads it.
pub(crate) async fn database_of<'a>(
    connection: &'a PgConnection,
    path: &'a [String],
) -> Result<(&'a str, crate::connection::ClientRef<'a>)> {
    let database = path
        .first()
        .map_or(connection.database.as_str(), String::as_str);
    Ok((database, connection.client(database).await?))
}
