//! The `CREATE` of an object, rebuilt from `system_schema`: a keyspace with its replication, a
//! table with its key, clustering order and options (and its indexes), a materialized view, a
//! user type, a function, an index.
use super::{columns, unknown};
use crate::connection::{rows, text};
use nexo_driver_sdk::{Result, Value, protocol::Ddl};
use scylla::client::session::Session;

/// A name as CQL writes it: quoted unless it is lowercase letters, digits and `_`.
pub(crate) fn quote(name: &str) -> String {
    let plain = name.chars().next().is_some_and(|c| c.is_ascii_lowercase())
        && name
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_');
    if plain {
        name.to_owned()
    } else {
        format!("\"{}\"", name.replace('"', "\"\""))
    }
}
fn literal(text: &str) -> String {
    format!("'{}'", text.replace('\'', "''"))
}
/// A map of `system_schema` (replication, compaction…) as a CQL map literal.
fn map_literal(value: &Value) -> String {
    let Value::Typed { text, .. } = value else {
        return "{}".into();
    };
    let Ok(serde_json::Value::Object(map)) = serde_json::from_str::<serde_json::Value>(text) else {
        return "{}".into();
    };
    let pairs: Vec<String> = map
        .iter()
        .map(|(key, value)| {
            format!(
                "{}: {}",
                literal(key),
                literal(value.as_str().unwrap_or_default())
            )
        })
        .collect();
    format!("{{{}}}", pairs.join(", "))
}

async fn table(session: &Session, keyspace: &str, name: &str) -> Result<String> {
    let (names, found) = rows(
        session,
        "SELECT * FROM system_schema.tables WHERE keyspace_name = ? AND table_name = ?",
        &[keyspace, name],
    )
    .await?;
    let row = found.first().ok_or_else(unknown)?;
    let columns = columns(session, keyspace, name).await?;
    let of = |kind: &str| -> Vec<&Vec<Value>> {
        columns.iter().filter(|row| text(row, 2) == kind).collect()
    };
    let mut lines: Vec<String> = columns
        .iter()
        .map(|row| {
            let stat = if text(row, 2) == "static" {
                " STATIC"
            } else {
                ""
            };
            format!("    {} {}{stat}", quote(&text(row, 0)), text(row, 1))
        })
        .collect();
    let partition: Vec<String> = of("partition_key")
        .iter()
        .map(|row| quote(&text(row, 0)))
        .collect();
    let clustering: Vec<String> = of("clustering")
        .iter()
        .map(|row| quote(&text(row, 0)))
        .collect();
    let partition = if partition.len() == 1 {
        partition[0].clone()
    } else {
        format!("({})", partition.join(", "))
    };
    let key = std::iter::once(partition)
        .chain(clustering.iter().cloned())
        .collect::<Vec<_>>()
        .join(", ");
    lines.push(format!("    PRIMARY KEY ({key})"));
    let mut with = Vec::new();
    let order: Vec<String> = of("clustering")
        .iter()
        .map(|row| format!("{} {}", quote(&text(row, 0)), text(row, 4).to_uppercase()))
        .collect();
    if !order.is_empty() {
        with.push(format!("CLUSTERING ORDER BY ({})", order.join(", ")));
    }
    for (column, value) in names.iter().zip(row) {
        let option = match (column.name.as_str(), value) {
            ("comment", Value::Text(text)) => literal(text),
            ("default_time_to_live" | "gc_grace_seconds", Value::Integer(number)) => {
                number.to_string()
            }
            ("compaction" | "compression" | "caching", value @ Value::Typed { .. }) => {
                map_literal(value)
            }
            _ => continue,
        };
        with.push(format!("{} = {option}", column.name));
    }
    let mut ddl = format!(
        "CREATE TABLE {}.{} (\n{}\n)",
        quote(keyspace),
        quote(name),
        lines.join(",\n")
    );
    if !with.is_empty() {
        ddl.push_str(&format!(" WITH {}", with.join("\n    AND ")));
    }
    ddl.push_str(";\n");
    let (_, indexes) = rows(session, "SELECT index_name, options FROM system_schema.indexes WHERE keyspace_name = ? AND table_name = ?", &[keyspace, name]).await?;
    for index in &indexes {
        ddl.push_str(&index_ddl(keyspace, name, index));
    }
    Ok(ddl)
}

fn index_ddl(keyspace: &str, table: &str, row: &[Value]) -> String {
    let target = match &row[1] {
        Value::Typed { text, .. } => serde_json::from_str::<serde_json::Value>(text)
            .ok()
            .and_then(|map| {
                map.get("target")
                    .and_then(|t| t.as_str())
                    .map(str::to_owned)
            })
            .unwrap_or_default(),
        _ => String::new(),
    };
    format!(
        "CREATE INDEX {} ON {}.{} ({target});\n",
        quote(&text(row, 0)),
        quote(keyspace),
        quote(table)
    )
}

pub(crate) async fn ddl(session: &Session, path: &[String]) -> Result<Ddl> {
    let path: Vec<&str> = path.iter().map(String::as_str).collect();
    let sql = match path.as_slice() {
        [keyspace] => {
            let (_, found) = rows(session, "SELECT replication, durable_writes FROM system_schema.keyspaces WHERE keyspace_name = ?", &[keyspace]).await?;
            let row = found.first().ok_or_else(unknown)?;
            format!(
                "CREATE KEYSPACE {} WITH replication = {} AND durable_writes = {};\n",
                quote(keyspace),
                map_literal(&row[0]),
                text(row, 1)
            )
        }
        [keyspace, "tables", name] => table(session, keyspace, name).await?,
        [keyspace, "views", name] => {
            let (_, found) = rows(session, "SELECT base_table_name, where_clause FROM system_schema.views WHERE keyspace_name = ? AND view_name = ?", &[keyspace, name]).await?;
            let row = found.first().ok_or_else(unknown)?;
            let columns = columns(session, keyspace, name).await?;
            let key = |kind: &str| -> Vec<String> {
                columns
                    .iter()
                    .filter(|row| text(row, 2) == kind)
                    .map(|row| quote(&text(row, 0)))
                    .collect()
            };
            let partition = key("partition_key");
            let partition = if partition.len() == 1 {
                partition[0].clone()
            } else {
                format!("({})", partition.join(", "))
            };
            let primary = std::iter::once(partition)
                .chain(key("clustering"))
                .collect::<Vec<_>>()
                .join(", ");
            format!(
                "CREATE MATERIALIZED VIEW {}.{} AS\n    SELECT * FROM {}.{}\n    WHERE {}\n    PRIMARY KEY ({primary});\n",
                quote(keyspace),
                quote(name),
                quote(keyspace),
                quote(&text(row, 0)),
                text(row, 1)
            )
        }
        [keyspace, "types", name] => {
            let (_, found) = rows(session, "SELECT field_names, field_types FROM system_schema.types WHERE keyspace_name = ? AND type_name = ?", &[keyspace, name]).await?;
            let row = found.first().ok_or_else(unknown)?;
            let (Value::Array(fields), Value::Array(types)) = (&row[0], &row[1]) else {
                return Err(unknown());
            };
            let fields: Vec<String> = fields
                .iter()
                .zip(types)
                .map(|(field, typ)| {
                    format!(
                        "    {} {}",
                        quote(&text(std::slice::from_ref(field), 0)),
                        text(std::slice::from_ref(typ), 0)
                    )
                })
                .collect();
            format!(
                "CREATE TYPE {}.{} (\n{}\n);\n",
                quote(keyspace),
                quote(name),
                fields.join(",\n")
            )
        }
        [keyspace, "functions", name] => {
            let (_, found) = rows(
                session,
                "SELECT argument_names, argument_types, return_type, language, body, called_on_null_input \
                 FROM system_schema.functions WHERE keyspace_name = ? AND function_name = ?",
                &[keyspace, name],
            )
            .await?;
            let mut sql = String::new();
            for row in &found {
                let (Value::Array(names), Value::Array(types)) = (&row[0], &row[1]) else {
                    continue;
                };
                let arguments: Vec<String> = names
                    .iter()
                    .zip(types)
                    .map(|(name, typ)| {
                        format!(
                            "{} {}",
                            quote(&text(std::slice::from_ref(name), 0)),
                            text(std::slice::from_ref(typ), 0)
                        )
                    })
                    .collect();
                let null = if text(row, 5) == "true" {
                    "CALLED"
                } else {
                    "RETURNS NULL"
                };
                sql.push_str(&format!(
                    "CREATE FUNCTION {}.{} ({})\n    {null} ON NULL INPUT\n    RETURNS {}\n    LANGUAGE {}\n    AS $${}$$;\n",
                    quote(keyspace),
                    quote(name),
                    arguments.join(", "),
                    text(row, 2),
                    text(row, 3),
                    text(row, 4)
                ));
            }
            sql
        }
        [keyspace, "indexes", name] | [keyspace, "tables", _, "indexes", name] => {
            let (_, found) = rows(session, "SELECT index_name, options, table_name FROM system_schema.indexes WHERE keyspace_name = ?", &[keyspace]).await?;
            let row = found
                .iter()
                .find(|row| text(row, 0) == *name)
                .ok_or_else(unknown)?;
            index_ddl(keyspace, &text(row, 2), row)
        }
        _ => return Err(unknown()),
    };
    Ok(Ddl { sql })
}
