//! The tree of HiveServer2: databases (`GetSchemas`), their tables and views (`GetTables`)
//! and the columns of each (`GetColumns`), as JDBC's metadata lists them; a table's sheet
//! from `DESCRIBE FORMATTED` and its DDL from `SHOW CREATE TABLE`.
use crate::{session::Session, thrift::Thrift};
use nexo_driver_sdk::{
    DriverError, Result, Value,
    protocol::{Ddl, ObjectDescription, Property, Section, TreeNode},
};

/// Rows a list of the tree reads at most.
const NODES: usize = 10_000;

fn text(value: Option<&Value>) -> String {
    match value {
        Some(Value::Text(text)) => text.clone(),
        Some(Value::Typed { text, .. }) => text.clone(),
        Some(Value::Integer(number)) => number.to_string(),
        _ => String::new(),
    }
}

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

/// An identifier between backticks, as HiveQL quotes it.
pub fn quote(name: &str) -> String {
    format!("`{}`", name.replace('`', "``"))
}

fn checked<'a>(path: &'a [String], depth: usize, what: &str) -> Result<&'a [String]> {
    if path.len() != depth || path.iter().any(|part| part.is_empty()) {
        return Err(DriverError::invalid(format!("Only {what} has this")));
    }
    Ok(path)
}

pub async fn tree(session: &Session, path: &[String]) -> Result<Vec<TreeNode>> {
    match path {
        [] => {
            let operation = session.catalog("GetSchemas", Vec::new()).await?;
            let (_, rows) = session.read_all(operation, NODES).await?;
            Ok(rows
                .iter()
                .map(|row| node("database", &text(row.first()), None, true, &["open"]))
                .collect())
        }
        [database] => {
            let fields = vec![(3, Thrift::text(database))];
            let operation = session.catalog("GetTables", fields).await?;
            let (_, rows) = session.read_all(operation, NODES).await?;
            // TABLE_CAT, TABLE_SCHEM, TABLE_NAME, TABLE_TYPE, REMARKS.
            Ok(rows
                .iter()
                .map(|row| {
                    let kind = text(row.get(3)).to_ascii_uppercase();
                    let view = kind.contains("VIEW");
                    node(
                        if view { "view" } else { "table" },
                        &text(row.get(2)),
                        Some(kind.to_ascii_lowercase().replace('_', " ")),
                        true,
                        &["open", "data", "ddl"],
                    )
                })
                .collect())
        }
        [database, table] => {
            let fields = vec![(3, Thrift::text(database)), (4, Thrift::text(table))];
            let operation = session.catalog("GetColumns", fields).await?;
            let (_, rows) = session.read_all(operation, NODES).await?;
            // COLUMN_NAME (4th) and TYPE_NAME (6th) of JDBC's columns.
            Ok(rows
                .iter()
                .map(|row| {
                    node(
                        "column",
                        &text(row.get(3)),
                        Some(text(row.get(5))),
                        false,
                        &[],
                    )
                })
                .collect())
        }
        _ => Ok(Vec::new()),
    }
}

/// A table or a view by `DESCRIBE FORMATTED`: its columns, then its details by section.
pub async fn describe(session: &Session, path: &[String]) -> Result<ObjectDescription> {
    let path = checked(path, 2, "a table")?;
    let sql = format!("DESCRIBE FORMATTED {}.{}", quote(&path[0]), quote(&path[1]));
    let operation = session.start(&sql).await?;
    let (_, rows) = session.read_all(operation, NODES).await?;
    let mut columns = Vec::new();
    let mut properties = Vec::new();
    let mut detail = false;
    for row in &rows {
        let (name, value) = (text(row.first()), text(row.get(1)));
        let name = name.trim().trim_end_matches(':').to_owned();
        if name.starts_with('#') {
            detail = name.contains("Detailed") || name.contains("Storage");
            continue;
        }
        if name.is_empty() {
            continue;
        }
        if detail {
            properties.push(Property {
                name,
                value: Value::Text(value.trim().to_owned()),
            });
        } else {
            columns.push(vec![
                Value::Text(name),
                Value::Text(value.trim().to_owned()),
                Value::Text(text(row.get(2)).trim().to_owned()),
            ]);
        }
    }
    Ok(ObjectDescription {
        kind: "table".into(),
        name: path[1].clone(),
        properties,
        sections: vec![Section {
            id: "columns".into(),
            title: "Columns".into(),
            columns: vec!["Name".into(), "Type".into(), "Comment".into()],
            rows: columns,
        }],
    })
}

pub async fn ddl(session: &Session, path: &[String]) -> Result<Ddl> {
    let path = checked(path, 2, "a table")?;
    let sql = format!("SHOW CREATE TABLE {}.{}", quote(&path[0]), quote(&path[1]));
    let operation = session.start(&sql).await?;
    let (_, rows) = session.read_all(operation, NODES).await?;
    let lines: Vec<String> = rows.iter().map(|row| text(row.first())).collect();
    Ok(Ddl {
        sql: lines.join("\n"),
    })
}
