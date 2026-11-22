//! What an object of the tree is: a keyspace with its replication and tables, a table or a
//! view with its options, columns (and their place in the key) and indexes, a user type with
//! its fields, a function or aggregate with its signature.
use super::{columns, key_role, replication, unknown};
use crate::connection::{rows, text};
use nexo_driver_sdk::{
    Result, Value,
    protocol::{ObjectDescription, Property, Section},
};
use scylla::client::session::Session;

fn property(name: &str, value: Value) -> Property {
    Property {
        name: name.into(),
        value,
    }
}
fn section(id: &str, title: &str, columns: &[&str], rows: Vec<Vec<Value>>) -> Section {
    Section {
        id: id.into(),
        title: title.into(),
        columns: columns.iter().map(|column| (*column).to_owned()).collect(),
        rows,
    }
}
fn texts(cells: &[String]) -> Vec<Value> {
    cells.iter().cloned().map(Value::Text).collect()
}

/// The options of a table or view row of `system_schema` as properties.
fn options(columns: &[nexo_driver_sdk::Column], row: &[Value]) -> Vec<Property> {
    columns
        .iter()
        .zip(row)
        .filter(|(column, value)| !matches!(value, Value::Null) && column.name != "keyspace_name")
        .map(|(column, value)| property(&column.name, value.clone()))
        .collect()
}

pub(crate) async fn describe(session: &Session, path: &[String]) -> Result<ObjectDescription> {
    let path: Vec<&str> = path.iter().map(String::as_str).collect();
    let object = |kind: &str, name: &str, properties, sections| ObjectDescription {
        kind: kind.into(),
        name: name.into(),
        properties,
        sections,
    };
    Ok(match path.as_slice() {
        [keyspace] => {
            let (_, found) = rows(session, "SELECT replication, durable_writes FROM system_schema.keyspaces WHERE keyspace_name = ?", &[keyspace]).await?;
            let row = found.first().ok_or_else(unknown)?;
            let (_, tables) = rows(
                session,
                "SELECT table_name, comment FROM system_schema.tables WHERE keyspace_name = ?",
                &[keyspace],
            )
            .await?;
            object(
                "schema",
                keyspace,
                vec![
                    property("replication", Value::Text(replication(&row[0]))),
                    property("durable_writes", row[1].clone()),
                ],
                vec![section("tables", "Tables", &["Name", "Comment"], tables)],
            )
        }
        [keyspace, kind @ ("tables" | "views"), table] => {
            let cql = if *kind == "tables" {
                "SELECT * FROM system_schema.tables WHERE keyspace_name = ? AND table_name = ?"
            } else {
                "SELECT * FROM system_schema.views WHERE keyspace_name = ? AND view_name = ?"
            };
            let (names, found) = rows(session, cql, &[keyspace, table]).await?;
            let row = found.first().ok_or_else(unknown)?;
            let columns: Vec<Vec<Value>> = columns(session, keyspace, table)
                .await?
                .iter()
                .map(|row| texts(&[text(row, 0), text(row, 1), key_role(row)]))
                .collect();
            let (_, indexes) = rows(
                session,
                "SELECT index_name, kind, options FROM system_schema.indexes WHERE keyspace_name = ? AND table_name = ?",
                &[keyspace, table],
            )
            .await?;
            object(
                if *kind == "tables" { "table" } else { "view" },
                table,
                options(&names, row),
                vec![
                    section("columns", "Columns", &["Name", "Type", "Key"], columns),
                    section("indexes", "Indexes", &["Name", "Kind", "Options"], indexes),
                ],
            )
        }
        [keyspace, "types", name] => {
            let (_, found) = rows(session, "SELECT field_names, field_types FROM system_schema.types WHERE keyspace_name = ? AND type_name = ?", &[keyspace, name]).await?;
            let row = found.first().ok_or_else(unknown)?;
            let (Value::Array(fields), Value::Array(types)) = (&row[0], &row[1]) else {
                return Err(unknown());
            };
            let rows = fields
                .iter()
                .zip(types)
                .map(|(field, typ)| vec![field.clone(), typ.clone()])
                .collect();
            object(
                "type",
                name,
                Vec::new(),
                vec![section("fields", "Fields", &["Name", "Type"], rows)],
            )
        }
        [keyspace, kind @ ("functions" | "aggregates"), name] => {
            let cql = if *kind == "functions" {
                "SELECT * FROM system_schema.functions WHERE keyspace_name = ? AND function_name = ?"
            } else {
                "SELECT * FROM system_schema.aggregates WHERE keyspace_name = ? AND aggregate_name = ?"
            };
            let (names, found) = rows(session, cql, &[keyspace, name]).await?;
            let row = found.first().ok_or_else(unknown)?;
            object(
                if *kind == "functions" {
                    "function"
                } else {
                    "aggregate"
                },
                name,
                options(&names, row),
                Vec::new(),
            )
        }
        _ => return Err(unknown()),
    })
}
