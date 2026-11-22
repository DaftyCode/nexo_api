//! The tree and the descriptions (DB-30). Files: a table per file at the top, with its columns.
//! A DuckDB database: its schemas, their tables and views, and their columns.
use crate::connection::FilesConnection;
use nexo_driver_sdk::{
    DriverError, Result, Value,
    protocol::{Ddl, ObjectDescription, Property, Section, TreeNode},
};

fn node(
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
        detail,
        has_children: children,
        actions: actions.iter().map(|action| (*action).to_owned()).collect(),
        system: false,
    }
}
fn text(value: &Value) -> String {
    match value {
        Value::Text(text) | Value::Typed { text, .. } => text.clone(),
        Value::Null => String::new(),
        other => serde_json::to_value(other)
            .map(|json| json.to_string())
            .unwrap_or_default(),
    }
}
const TABLE: [&str; 3] = ["open", "data", "ddl"];

/// The schema and the table a path names: files live in `main`.
fn table_of(connection: &FilesConnection, path: &[String]) -> Option<(String, String)> {
    if connection.files {
        return path.first().map(|table| ("main".to_owned(), table.clone()));
    }
    match path {
        [schema, _, table, ..] => Some((schema.clone(), table.clone())),
        _ => None,
    }
}

async fn columns(
    connection: &FilesConnection,
    schema: &str,
    table: &str,
) -> Result<Vec<Vec<Value>>> {
    Ok(connection
        .query(
            "SELECT column_name, data_type, is_nullable FROM information_schema.columns \
             WHERE table_schema = ? AND table_name = ? ORDER BY ordinal_position",
            vec![Value::Text(schema.into()), Value::Text(table.into())],
        )
        .await?
        .rows)
}

pub async fn children(connection: &FilesConnection, path: &[String]) -> Result<Vec<TreeNode>> {
    let tables = |schema: &str, kind: &str| {
        connection.query(
            "SELECT table_name FROM information_schema.tables \
             WHERE table_schema = ? AND table_type = ? ORDER BY table_name",
            vec![Value::Text(schema.into()), Value::Text(kind.into())],
        )
    };
    let column_nodes = |rows: Vec<Vec<Value>>| {
        rows.iter()
            .map(|row| node("column", &text(&row[0]), Some(text(&row[1])), false, &[]))
            .collect::<Vec<_>>()
    };
    if connection.files {
        return match path {
            [] => {
                let mut nodes = Vec::new();
                for kind in ["VIEW", "BASE TABLE"] {
                    for row in tables("main", kind).await?.rows {
                        nodes.push(node("table", &text(&row[0]), None, true, &TABLE));
                    }
                }
                nodes.sort_by(|a, b| a.name.cmp(&b.name));
                Ok(nodes)
            }
            [table] => Ok(column_nodes(columns(connection, "main", table).await?)),
            _ => Ok(Vec::new()),
        };
    }
    match path {
        [] => {
            let rows = connection
                .query(
                    "SELECT DISTINCT schema_name FROM information_schema.schemata \
                     WHERE catalog_name = current_database() ORDER BY schema_name",
                    Vec::new(),
                )
                .await?
                .rows;
            Ok(rows
                .iter()
                .map(|row| {
                    let name = text(&row[0]);
                    let mut found = node("schema", &name, None, true, &[]);
                    found.system = name == "information_schema" || name == "pg_catalog";
                    found
                })
                .collect())
        }
        [_] => Ok(vec![
            node("folder", "tables", None, true, &[]),
            node("folder", "views", None, true, &[]),
        ]),
        [schema, folder] => {
            let (kind, table) = if folder == "views" {
                ("VIEW", "view")
            } else {
                ("BASE TABLE", "table")
            };
            Ok(tables(schema, kind)
                .await?
                .rows
                .iter()
                .map(|row| node(table, &text(&row[0]), None, true, &TABLE))
                .collect())
        }
        [schema, _, table] => Ok(column_nodes(columns(connection, schema, table).await?)),
        _ => Ok(Vec::new()),
    }
}

pub async fn describe(connection: &FilesConnection, path: &[String]) -> Result<ObjectDescription> {
    let Some((schema, table)) = table_of(connection, path) else {
        return Ok(ObjectDescription {
            kind: "schema".into(),
            name: path.join("."),
            ..Default::default()
        });
    };
    let rows = columns(connection, &schema, &table).await?;
    let columns_section = Section {
        id: "columns".into(),
        title: "Columns".into(),
        columns: vec!["Name".into(), "Type".into(), "Nullable".into()],
        rows,
    };
    Ok(ObjectDescription {
        kind: "table".into(),
        name: if connection.files {
            table.clone()
        } else {
            format!("{schema}.{table}")
        },
        properties: vec![Property {
            name: "Schema".into(),
            value: Value::Text(schema),
        }],
        sections: vec![columns_section],
    })
}

pub async fn ddl(connection: &FilesConnection, path: &[String]) -> Result<Ddl> {
    let (schema, table) = table_of(connection, path)
        .ok_or_else(|| DriverError::invalid("Choose a table or a view"))?;
    let rows = connection
        .query(
            "SELECT sql FROM duckdb_views() WHERE schema_name = ? AND view_name = ? \
             UNION ALL SELECT sql FROM duckdb_tables() WHERE schema_name = ? AND table_name = ?",
            vec![
                Value::Text(schema.clone()),
                Value::Text(table.clone()),
                Value::Text(schema),
                Value::Text(table),
            ],
        )
        .await?
        .rows;
    Ok(Ddl {
        sql: rows.first().map(|row| text(&row[0])).unwrap_or_default(),
    })
}
