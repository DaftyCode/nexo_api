//! What an object is like: its properties and its lists, named in the queries themselves so
//! the interface shows them without knowing SQLite.
use super::{module_of, properties, query, section, text, unknown};
use crate::{connection::SqliteConnection, session::Rows};
use nexo_driver_sdk::{
    Result, Value,
    protocol::{ObjectDescription, Property, Section},
};

fn described(kind: &str, name: &str, rows: &Rows, sections: Vec<Section>) -> ObjectDescription {
    ObjectDescription {
        kind: kind.into(),
        name: name.into(),
        properties: properties(rows),
        sections,
    }
}

/// The statement that made an object, as `sqlite_schema` keeps it.
async fn definition(connection: &SqliteConnection, name: &str) -> Result<Option<String>> {
    let rows = query(
        connection,
        "SELECT sql FROM sqlite_schema WHERE name = ? AND sql IS NOT NULL",
        &[name],
    )
    .await?;
    Ok(rows.rows.first().map(|row| text(row, 0)))
}

const COLUMNS: &str = "SELECT cid + 1 AS \"#\", name AS Name, type AS Type, \
     CASE WHEN \"notnull\" THEN 'NO' ELSE 'YES' END AS Nullable, dflt_value AS \"Default\", \
     CASE WHEN pk > 0 THEN 'PRI' END AS \"Key\", \
     CASE hidden WHEN 1 THEN 'hidden' WHEN 2 THEN 'generated, virtual' WHEN 3 THEN 'generated, stored' END AS Extra \
     FROM pragma_table_xinfo(?) ORDER BY cid";
const INDEXES: &str = "SELECT l.name AS Name, \
     (SELECT group_concat(coalesce(i.name, 'expression'), ', ') FROM pragma_index_xinfo(l.name) i WHERE i.key) AS Columns, \
     CASE WHEN l.\"unique\" THEN 'yes' ELSE 'no' END AS \"Unique\", \
     CASE l.origin WHEN 'pk' THEN 'primary key' WHEN 'u' THEN 'unique constraint' ELSE 'created' END AS Origin, \
     CASE WHEN l.partial THEN 'yes' ELSE 'no' END AS Partial FROM pragma_index_list(?) l ORDER BY l.name";
const FOREIGN_KEYS: &str = "SELECT id AS Name, group_concat(\"from\", ', ') AS Columns, \
     \"table\" AS \"Referenced table\", group_concat(\"to\", ', ') AS \"Referenced columns\", \
     on_update AS \"On update\", on_delete AS \"On delete\" \
     FROM pragma_foreign_key_list(?) GROUP BY id ORDER BY id";
const REFERENCES: &str = "SELECT f.id AS Name, m.name AS \"Table\", group_concat(f.\"from\", ', ') AS Columns, \
     group_concat(f.\"to\", ', ') AS \"Referenced columns\", m.name AS \"Table name\" \
     FROM sqlite_schema m, pragma_foreign_key_list(m.name) f WHERE m.type = 'table' AND f.\"table\" = ? \
     GROUP BY m.name, f.id ORDER BY m.name, f.id";
const TRIGGERS: &str = "SELECT name AS Name, sql AS Statement FROM sqlite_schema \
     WHERE type = 'trigger' AND tbl_name = ? ORDER BY name";

/// A table or a view: its kind, columns, keys, indexes, triggers and definition.
async fn relation(connection: &SqliteConnection, name: &str) -> Result<ObjectDescription> {
    let header = query(
        connection,
        "SELECT CASE l.type WHEN 'virtual' THEN 'virtual table' ELSE l.type END AS Kind, \
         CASE WHEN l.wr THEN 'yes' END AS \"Without rowid\", CASE WHEN l.strict THEN 'yes' END AS Strict \
         FROM pragma_table_list l WHERE l.schema = 'main' AND l.name = ?",
        &[name],
    )
    .await?;
    let kind = header
        .rows
        .first()
        .map(|row| text(row, 0))
        .ok_or_else(unknown)?;
    let at = [name];
    let mut sections = vec![section(
        "columns",
        "Columns",
        query(connection, COLUMNS, &at).await?,
    )];
    let parts: &[(&str, &str, &str)] = if kind == "view" {
        &[("triggers", "Triggers", TRIGGERS)]
    } else {
        &[
            ("indexes", "Indexes", INDEXES),
            ("foreign-keys", "Foreign keys", FOREIGN_KEYS),
            ("references", "Referenced by", REFERENCES),
            ("triggers", "Triggers", TRIGGERS),
        ]
    };
    for (id, title, sql) in parts {
        sections.push(section(id, title, query(connection, sql, &at).await?));
    }
    let shown = if kind.contains("table") || kind == "shadow" {
        "table"
    } else {
        kind.as_str()
    };
    let mut description = described(shown, name, &header, sections);
    if let Some(sql) = definition(connection, name).await? {
        if kind == "virtual table"
            && let Some(module) = module_of(&sql)
        {
            description.properties.push(Property {
                name: "Module".into(),
                value: Value::Text(module),
            });
        }
        if kind == "view" {
            description.properties.push(Property {
                name: "Definition".into(),
                value: Value::Text(sql),
            });
        }
    }
    Ok(description)
}

/// An index or a trigger, from `sqlite_schema`.
async fn schema_object(
    connection: &SqliteConnection,
    kind: &str,
    name: &str,
) -> Result<ObjectDescription> {
    let rows = query(
        connection,
        "SELECT type AS Kind, tbl_name AS \"Table\", sql AS Definition FROM sqlite_schema \
         WHERE type = ? AND name = ?",
        &[kind, name],
    )
    .await?;
    if rows.rows.is_empty() {
        return Err(unknown());
    }
    let mut sections = Vec::new();
    if kind == "index" {
        let columns = query(
            connection,
            "SELECT seqno + 1 AS \"#\", coalesce(name, 'expression') AS Name, \
             CASE WHEN \"desc\" THEN 'descending' ELSE 'ascending' END AS \"Order\", coll AS Collation \
             FROM pragma_index_xinfo(?) WHERE key ORDER BY seqno",
            &[name],
        )
        .await?;
        sections.push(section("columns", "Columns", columns));
    }
    Ok(described(kind, name, &rows, sections))
}

pub(crate) async fn describe(
    connection: &SqliteConnection,
    path: &[String],
) -> Result<ObjectDescription> {
    let segments: Vec<&str> = path.iter().map(String::as_str).collect();
    match segments.as_slice() {
        ["tables" | "views", name] => relation(connection, name).await,
        ["indexes", name] | ["tables", _, "indexes", name] => {
            schema_object(connection, "index", name).await
        }
        ["triggers", name] | ["tables" | "views", _, "triggers", name] => {
            schema_object(connection, "trigger", name).await
        }
        ["tables" | "views", table, "columns", column] => {
            let rows = query(
                connection,
                "SELECT 'column' AS Kind, type AS Type, CASE WHEN \"notnull\" THEN 'NO' ELSE 'YES' END AS Nullable, \
                 dflt_value AS \"Default\", CASE WHEN pk > 0 THEN 'PRI' END AS \"Key\", \
                 CASE hidden WHEN 1 THEN 'hidden' WHEN 2 THEN 'generated, virtual' WHEN 3 THEN 'generated, stored' END AS Extra \
                 FROM pragma_table_xinfo(?) WHERE name = ?",
                &[table, column],
            )
            .await?;
            if rows.rows.is_empty() {
                return Err(unknown());
            }
            Ok(described(
                "column",
                &format!("{table}.{column}"),
                &rows,
                Vec::new(),
            ))
        }
        _ => Err(unknown()),
    }
}
