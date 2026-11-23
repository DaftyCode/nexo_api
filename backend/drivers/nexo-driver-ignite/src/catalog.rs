//! The tree of Ignite 3 from its system views (3.1 and later): schemas (`SYSTEM.SCHEMAS`),
//! their tables with their distribution zone (`SYSTEM.TABLES`) and system views
//! (`SYSTEM.SYSTEM_VIEWS`), and the columns of each; a table's sheet with its zone, its keys
//! and its indexes, and its DDL rebuilt from the views, since Ignite has no `SHOW CREATE`.
use crate::connection::Connection;
use nexo_driver_sdk::{
    DriverError, Result, Value,
    protocol::{Ddl, ObjectDescription, Property, Section, TreeNode},
};

pub mod ddl;

/// The schema of Ignite's own views.
pub const SYSTEM: &str = "SYSTEM";

pub fn text(value: Option<&Value>) -> String {
    match value {
        Some(Value::Text(text)) => text.clone(),
        Some(Value::Typed { text, .. }) => text.clone(),
        Some(Value::Integer(number)) => number.to_string(),
        Some(Value::Bool(flag)) => flag.to_string(),
        _ => String::new(),
    }
}

fn node(kind: &str, name: &str, detail: Option<String>, children: bool, system: bool) -> TreeNode {
    let actions: &[&str] = match kind {
        "schema" => &["open"],
        "table" | "view" => &["open", "data", "ddl"],
        _ => &[],
    };
    TreeNode {
        kind: kind.into(),
        name: name.into(),
        label: name.into(),
        detail,
        has_children: children,
        actions: actions.iter().map(|action| (*action).to_owned()).collect(),
        system,
    }
}

/// An identifier between double quotes, as Ignite's SQL quotes it.
pub fn quote(name: &str) -> String {
    format!("\"{}\"", name.replace('"', "\"\""))
}

fn checked<'a>(path: &'a [String], depth: usize, what: &str) -> Result<&'a [String]> {
    if path.len() != depth || path.iter().any(|part| part.is_empty()) {
        return Err(DriverError::invalid(format!("Only {what} has this")));
    }
    Ok(path)
}

fn names(path: &[String]) -> Vec<Value> {
    path.iter().map(|part| Value::Text(part.clone())).collect()
}

/// Whether a table is one of the system's views: they are not in `SYSTEM.TABLES`.
async fn is_view(connection: &Connection, path: &[String]) -> Result<bool> {
    let found = connection
        .query(
            "SELECT 1 FROM SYSTEM.SYSTEM_VIEWS WHERE SCHEMA_NAME = ? AND VIEW_NAME = ?",
            &names(path),
        )
        .await?;
    Ok(!found.is_empty())
}

pub async fn tree(connection: &Connection, path: &[String]) -> Result<Vec<TreeNode>> {
    match path {
        [] => {
            let sql = "SELECT SCHEMA_NAME FROM SYSTEM.SCHEMAS ORDER BY SCHEMA_NAME";
            let rows = connection.query(sql, &[]).await?;
            Ok(rows
                .iter()
                .map(|row| {
                    let name = text(row.first());
                    node("schema", &name, None, true, name == SYSTEM)
                })
                .collect())
        }
        [schema] => {
            let args = names(path);
            let tables = connection
                .query(
                    "SELECT TABLE_NAME, ZONE_NAME FROM SYSTEM.TABLES WHERE SCHEMA_NAME = ? \
                     ORDER BY TABLE_NAME",
                    &args,
                )
                .await?;
            let views = connection
                .query(
                    "SELECT VIEW_NAME, VIEW_TYPE FROM SYSTEM.SYSTEM_VIEWS WHERE SCHEMA_NAME = ? \
                     ORDER BY VIEW_NAME",
                    &args,
                )
                .await?;
            let system = schema == SYSTEM;
            let tables = tables.iter().map(|row| {
                let zone = text(row.get(1));
                node("table", &text(row.first()), Some(zone), true, system)
            });
            let views = views.iter().map(|row| {
                let scope = text(row.get(1)).to_ascii_lowercase();
                node("view", &text(row.first()), Some(scope), true, true)
            });
            Ok(tables.chain(views).collect())
        }
        [_, _] => {
            let columns = columns(connection, path).await?;
            Ok(columns
                .iter()
                .map(|column| {
                    node(
                        "column",
                        &column.name,
                        Some(column.sql_type()),
                        false,
                        false,
                    )
                })
                .collect())
        }
        _ => Ok(Vec::new()),
    }
}

/// A column of a table or a view, as the views describe it.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct TableColumn {
    pub name: String,
    /// Ignite's name of the type: `INT32`, `STRING`, `DECIMAL`…
    pub kind: String,
    pub nullable: bool,
    pub precision: i64,
    pub scale: i64,
    pub length: i64,
    pub key: Option<i64>,
    pub colocation: Option<i64>,
}

impl TableColumn {
    pub fn sql_type(&self) -> String {
        ddl::sql_type(self)
    }
}

fn number(value: Option<&Value>) -> Option<i64> {
    match value {
        Some(Value::Integer(number)) => Some(*number),
        _ => None,
    }
}

pub async fn columns(connection: &Connection, path: &[String]) -> Result<Vec<TableColumn>> {
    let path = checked(path, 2, "a table")?;
    let sql = if is_view(connection, path).await? {
        // 3.1 writes the column's name in `VIEW_NAME`: `NAME` (a reserved word) has it.
        "SELECT c.\"NAME\", c.COLUMN_TYPE, c.IS_NULLABLE_COLUMN, c.COLUMN_PRECISION, \
         c.COLUMN_SCALE, c.COLUMN_LENGTH, NULL, NULL \
         FROM SYSTEM.SYSTEM_VIEW_COLUMNS c JOIN SYSTEM.SYSTEM_VIEWS v ON v.VIEW_ID = c.VIEW_ID \
         WHERE v.SCHEMA_NAME = ? AND v.VIEW_NAME = ?"
    } else {
        "SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE_COLUMN, COLUMN_PRECISION, COLUMN_SCALE, \
         COLUMN_LENGTH, PK_COLUMN_ORDINAL, COLOCATION_COLUMN_ORDINAL FROM SYSTEM.TABLE_COLUMNS \
         WHERE SCHEMA_NAME = ? AND TABLE_NAME = ? ORDER BY COLUMN_ORDINAL"
    };
    let rows = connection.query(sql, &names(path)).await?;
    Ok(rows
        .iter()
        .map(|row| TableColumn {
            name: text(row.first()),
            kind: text(row.get(1)),
            nullable: row.get(2) == Some(&Value::Bool(true)),
            precision: number(row.get(3)).unwrap_or(0),
            scale: number(row.get(4)).unwrap_or(0),
            length: number(row.get(5)).unwrap_or(0),
            key: number(row.get(6)),
            colocation: number(row.get(7)),
        })
        .collect())
}

pub async fn describe(connection: &Connection, path: &[String]) -> Result<ObjectDescription> {
    let path = checked(path, 2, "a table")?;
    let columns = columns(connection, path).await?;
    let column_rows = columns
        .iter()
        .map(|column| {
            vec![
                Value::Text(column.name.clone()),
                Value::Text(column.sql_type()),
                Value::Bool(column.nullable),
                Value::Bool(column.key.is_some()),
            ]
        })
        .collect();
    let mut sections = vec![Section {
        id: "columns".into(),
        title: "Columns".into(),
        columns: vec![
            "Name".into(),
            "Type".into(),
            "Nullable".into(),
            "Key".into(),
        ],
        rows: column_rows,
    }];
    let mut properties = Vec::new();
    let table = ddl::table(connection, path).await?;
    if let Some(table) = &table {
        let property = |name: &str, value: &str| Property {
            name: name.into(),
            value: Value::Text(value.to_owned()),
        };
        properties.push(property("Distribution zone", &table.zone));
        properties.push(property("Storage profile", &table.storage));
        properties.push(property("Colocated by", &table.colocation));
        properties.push(property(
            "Primary key",
            &ddl::key_columns(&columns).join(", "),
        ));
        sections.push(Section {
            id: "indexes".into(),
            title: "Indexes".into(),
            columns: ["Name", "Type", "Unique", "Columns", "State"]
                .map(Into::into)
                .to_vec(),
            rows: table.indexes.iter().map(ddl::Index::row).collect(),
        });
    }
    Ok(ObjectDescription {
        kind: if table.is_some() { "table" } else { "view" }.into(),
        name: path[1].clone(),
        properties,
        sections,
    })
}

pub async fn ddl(connection: &Connection, path: &[String]) -> Result<Ddl> {
    let path = checked(path, 2, "a table")?;
    let columns = columns(connection, path).await?;
    let table = ddl::table(connection, path)
        .await?
        .ok_or_else(|| DriverError::unsupported("A system view has no DDL"))?;
    Ok(Ddl {
        sql: ddl::create(path, &columns, &table),
    })
}
