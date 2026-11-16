//! What an object is like: its properties and its lists, named in the queries themselves so
//! the interface shows them without knowing MySQL.
mod relation;

use super::{account, properties, query, section, unknown};
use crate::{connection::MyConnection, dialect::quoted, session::Rows};
use nexo_driver_sdk::{
    Result, Value,
    protocol::{ObjectDescription, Property, Section},
};
use relation::relation;

pub(super) fn described(
    kind: &str,
    name: &str,
    rows: &Rows,
    sections: Vec<Section>,
) -> ObjectDescription {
    ObjectDescription {
        kind: kind.into(),
        name: name.into(),
        properties: properties(rows),
        sections,
    }
}

/// The definition a `SHOW CREATE` gives, in the column `column`.
async fn created(connection: &MyConnection, sql: &str, column: &str) -> Option<String> {
    let rows = connection.query(sql, Vec::new()).await.ok()?;
    let at = rows.columns.iter().position(|name| name == column)?;
    match rows.rows.first()?.get(at)? {
        Value::Text(text) | Value::Typed { text, .. } => Some(text.clone()),
        _ => None,
    }
}

/// A procedure or a function, with its parameters and its definition.
async fn routine(
    connection: &MyConnection,
    db: &str,
    name: &str,
    kind: &str,
) -> Result<ObjectDescription> {
    let routine_type = kind.to_ascii_uppercase();
    let header = query(
        connection,
        "SELECT LOWER(ROUTINE_TYPE) AS Kind, DEFINER AS Definer, DTD_IDENTIFIER AS `Returns`, \
         SECURITY_TYPE AS `Security`, IS_DETERMINISTIC AS `Deterministic`, SQL_DATA_ACCESS AS `Data access`, \
         CREATED AS Created, LAST_ALTERED AS Modified, NULLIF(ROUTINE_COMMENT, '') AS Comment \
         FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA = ? AND ROUTINE_NAME = ? AND ROUTINE_TYPE = ?",
        &[db, name, &routine_type],
    )
    .await?;
    if header.rows.is_empty() {
        return Err(unknown());
    }
    let parameters = query(
        connection,
        "SELECT ORDINAL_POSITION AS `#`, PARAMETER_NAME AS Name, PARAMETER_MODE AS Mode, DTD_IDENTIFIER AS Type \
         FROM information_schema.PARAMETERS WHERE SPECIFIC_SCHEMA = ? AND SPECIFIC_NAME = ? \
         AND ROUTINE_TYPE = ? AND ORDINAL_POSITION > 0 ORDER BY 1",
        &[db, name, &routine_type],
    )
    .await?;
    let mut description = described(
        kind,
        &format!("{db}.{name}"),
        &header,
        vec![section("parameters", "Parameters", parameters)],
    );
    let show = format!("SHOW CREATE {routine_type} {}.{}", quoted(db), quoted(name));
    let column = if kind == "procedure" {
        "Create Procedure"
    } else {
        "Create Function"
    };
    if let Some(definition) = created(connection, &show, column).await {
        description.properties.push(Property {
            name: "Definition".into(),
            value: Value::Text(definition),
        });
    }
    Ok(description)
}

pub(crate) async fn describe(
    connection: &MyConnection,
    path: &[String],
) -> Result<ObjectDescription> {
    let segments: Vec<&str> = path.iter().map(String::as_str).collect();
    let single = |sql: &'static str, at: Vec<String>| async move {
        let at: Vec<&str> = at.iter().map(String::as_str).collect();
        query(connection, sql, &at).await
    };
    Ok(match segments.as_slice() {
        ["databases", db] => {
            let rows = single(
                "SELECT DEFAULT_CHARACTER_SET_NAME AS `Character set`, DEFAULT_COLLATION_NAME AS Collation, \
                 (SELECT COUNT(*) FROM information_schema.TABLES t WHERE t.TABLE_SCHEMA = s.SCHEMA_NAME) AS Tables, \
                 (SELECT CONCAT(ROUND(SUM(DATA_LENGTH + INDEX_LENGTH) / 1024), ' kB') FROM information_schema.TABLES t \
                 WHERE t.TABLE_SCHEMA = s.SCHEMA_NAME) AS Size FROM information_schema.SCHEMATA s WHERE SCHEMA_NAME = ?",
                vec![db.to_string()],
            )
            .await?;
            described("database", db, &rows, Vec::new())
        }
        ["databases", db, "tables" | "views", name] => relation(connection, db, name).await?,
        ["databases", db, "procedures", name] => routine(connection, db, name, "procedure").await?,
        ["databases", db, "functions", name] => routine(connection, db, name, "function").await?,
        ["databases", db, "triggers", name] => {
            let rows = single(
                "SELECT 'trigger' AS Kind, EVENT_OBJECT_TABLE AS `Table`, ACTION_TIMING AS Timing, \
                 EVENT_MANIPULATION AS Event, DEFINER AS Definer, CREATED AS Created, ACTION_STATEMENT AS Definition \
                 FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = ? AND TRIGGER_NAME = ?",
                vec![db.to_string(), name.to_string()],
            )
            .await?;
            described("trigger", &format!("{db}.{name}"), &rows, Vec::new())
        }
        ["databases", db, "events", name] => {
            let rows = single(
                "SELECT 'event' AS Kind, DEFINER AS Definer, EVENT_TYPE AS Type, EXECUTE_AT AS `Execute at`, \
                 CONCAT(INTERVAL_VALUE, ' ', INTERVAL_FIELD) AS `Every`, STARTS AS `Starts`, ENDS AS `Ends`, \
                 STATUS AS Status, CREATED AS Created, LAST_ALTERED AS Modified, \
                 NULLIF(EVENT_COMMENT, '') AS Comment, EVENT_DEFINITION AS Definition \
                 FROM information_schema.EVENTS WHERE EVENT_SCHEMA = ? AND EVENT_NAME = ?",
                vec![db.to_string(), name.to_string()],
            )
            .await?;
            described("event", &format!("{db}.{name}"), &rows, Vec::new())
        }
        ["databases", db, "sequences", name] => {
            let show = format!("SHOW CREATE SEQUENCE {}.{}", quoted(db), quoted(name));
            let mut description = described(
                "sequence",
                &format!("{db}.{name}"),
                &Rows {
                    columns: Vec::new(),
                    rows: Vec::new(),
                },
                Vec::new(),
            );
            if let Some(definition) = created(connection, &show, "Create Table").await {
                description.properties.push(Property {
                    name: "Definition".into(),
                    value: Value::Text(definition),
                });
            }
            description
        }
        ["databases", db, "indexes", index] | ["databases", db, "tables", _, "indexes", index]
            if !index.is_empty() =>
        {
            let (table, name) = match segments.as_slice() {
                [_, _, "tables", table, _, index] => (table.to_string(), index.to_string()),
                _ => {
                    let (table, name) = index.split_once('.').ok_or_else(unknown)?;
                    (table.to_owned(), name.to_owned())
                }
            };
            let rows = single(
                "SELECT 'index' AS Kind, TABLE_NAME AS `Table`, IF(MIN(NON_UNIQUE) = 0, 'yes', 'no') AS `Unique`, \
                 MIN(INDEX_TYPE) AS Type, GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX SEPARATOR ', ') AS Columns, \
                 NULLIF(MIN(INDEX_COMMENT), '') AS Comment FROM information_schema.STATISTICS \
                 WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND INDEX_NAME = ? GROUP BY TABLE_NAME",
                vec![db.to_string(), table.clone(), name.clone()],
            )
            .await?;
            described("index", &format!("{db}.{table}.{name}"), &rows, Vec::new())
        }
        [
            "databases",
            db,
            "tables" | "views",
            table,
            "columns",
            column,
        ] => {
            let rows = single(
                "SELECT 'column' AS Kind, COLUMN_TYPE AS Type, IS_NULLABLE AS Nullable, COLUMN_DEFAULT AS `Default`, \
                 NULLIF(EXTRA, '') AS Extra, NULLIF(COLUMN_KEY, '') AS `Key`, CHARACTER_SET_NAME AS `Character set`, \
                 COLLATION_NAME AS Collation, GENERATION_EXPRESSION AS `Generated`, NULLIF(COLUMN_COMMENT, '') AS Comment \
                 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND COLUMN_NAME = ?",
                vec![db.to_string(), table.to_string(), column.to_string()],
            )
            .await?;
            described(
                "column",
                &format!("{db}.{table}.{column}"),
                &rows,
                Vec::new(),
            )
        }
        ["users", user] => {
            let grants = connection
                .query(&format!("SHOW GRANTS FOR {}", account(user)?), Vec::new())
                .await?;
            let grants = Rows {
                columns: vec!["Grant".into()],
                rows: grants.rows,
            };
            described(
                "role",
                user,
                &Rows {
                    columns: Vec::new(),
                    rows: Vec::new(),
                },
                vec![section("grants", "Grants", grants)],
            )
        }
        _ => return Err(unknown()),
    })
}
