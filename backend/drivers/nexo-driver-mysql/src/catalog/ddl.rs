//! The DDL of an object, as the server writes it: `SHOW CREATE …` of each kind of object,
//! ended with `;`; an index as the `ALTER TABLE` that adds it; a user with its grants.
use super::{account, query, unknown};
use crate::{connection::MyConnection, dialect::quoted, session::Rows};
use nexo_driver_sdk::{DriverError, Result, Value, protocol::Ddl};

/// The text of the column `column` of the first row.
fn column(rows: &Rows, column: &str) -> Option<String> {
    let at = rows.columns.iter().position(|name| name == column)?;
    match rows.rows.first()?.get(at)? {
        Value::Text(text) | Value::Typed { text, .. } => Some(text.clone()),
        _ => None,
    }
}

/// The definition a `SHOW CREATE` statement gives, in its column `name`.
async fn show(connection: &MyConnection, sql: &str, name: &str) -> Result<String> {
    let rows = connection.query(sql, Vec::new()).await?;
    let text = column(&rows, name).ok_or_else(|| {
        DriverError::new(
            nexo_driver_sdk::ErrorCode::Permission,
            "The server did not give the definition: the user may not see it",
        )
    })?;
    Ok(format!("{};", text.trim_end().trim_end_matches(';')))
}

/// An index as the statement that adds it to its table.
async fn index(connection: &MyConnection, db: &str, table: &str, name: &str) -> Result<String> {
    let rows = query(
        connection,
        "SELECT MIN(NON_UNIQUE), MIN(INDEX_TYPE), GROUP_CONCAT(CONCAT('`', REPLACE(COLUMN_NAME, '`', '``'), '`', \
         IF(SUB_PART IS NULL, '', CONCAT('(', SUB_PART, ')'))) ORDER BY SEQ_IN_INDEX SEPARATOR ', ') \
         FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND INDEX_NAME = ? \
         GROUP BY INDEX_NAME",
        &[db, table, name],
    )
    .await?;
    let row = rows.rows.first().ok_or_else(unknown)?;
    let unique = super::text(row, 0) == "0";
    let kind = super::text(row, 1);
    let columns = super::text(row, 2);
    let target = format!("{}.{}", quoted(db), quoted(table));
    Ok(if name == "PRIMARY" {
        format!("ALTER TABLE {target} ADD PRIMARY KEY ({columns});")
    } else {
        let what = match (unique, kind.as_str()) {
            (true, _) => "UNIQUE INDEX",
            (_, "FULLTEXT") => "FULLTEXT INDEX",
            (_, "SPATIAL") => "SPATIAL INDEX",
            _ => "INDEX",
        };
        format!(
            "ALTER TABLE {target} ADD {what} {} ({columns});",
            quoted(name)
        )
    })
}

pub(crate) async fn ddl(connection: &MyConnection, path: &[String]) -> Result<Ddl> {
    let segments: Vec<&str> = path.iter().map(String::as_str).collect();
    let name = |db: &str, object: &str| format!("{}.{}", quoted(db), quoted(object));
    let sql = match segments.as_slice() {
        ["databases", db] => {
            show(
                connection,
                &format!("SHOW CREATE DATABASE {}", quoted(db)),
                "Create Database",
            )
            .await?
        }
        ["databases", db, "tables", table] => {
            show(
                connection,
                &format!("SHOW CREATE TABLE {}", name(db, table)),
                "Create Table",
            )
            .await?
        }
        ["databases", db, "views", view] => {
            show(
                connection,
                &format!("SHOW CREATE VIEW {}", name(db, view)),
                "Create View",
            )
            .await?
        }
        ["databases", db, "procedures", routine] => {
            show(
                connection,
                &format!("SHOW CREATE PROCEDURE {}", name(db, routine)),
                "Create Procedure",
            )
            .await?
        }
        ["databases", db, "functions", routine] => {
            show(
                connection,
                &format!("SHOW CREATE FUNCTION {}", name(db, routine)),
                "Create Function",
            )
            .await?
        }
        ["databases", db, "triggers", trigger] => {
            show(
                connection,
                &format!("SHOW CREATE TRIGGER {}", name(db, trigger)),
                "SQL Original Statement",
            )
            .await?
        }
        ["databases", db, "events", event] => {
            show(
                connection,
                &format!("SHOW CREATE EVENT {}", name(db, event)),
                "Create Event",
            )
            .await?
        }
        ["databases", db, "sequences", sequence] => {
            show(
                connection,
                &format!("SHOW CREATE SEQUENCE {}", name(db, sequence)),
                "Create Table",
            )
            .await?
        }
        ["databases", db, "indexes", item] => {
            let (table, index_name) = item.split_once('.').ok_or_else(unknown)?;
            index(connection, db, table, index_name).await?
        }
        ["databases", db, "tables", table, "indexes", index_name] => {
            index(connection, db, table, index_name).await?
        }
        ["users", user] => {
            let account = account(user)?;
            let created = show(
                connection,
                &format!("SHOW CREATE USER {account}"),
                &format!("CREATE USER for {user}"),
            )
            .await
            .unwrap_or_default();
            let grants = connection
                .query(&format!("SHOW GRANTS FOR {account}"), Vec::new())
                .await?;
            let grants: Vec<String> = grants
                .rows
                .iter()
                .map(|row| format!("{};", super::text(row, 0)))
                .collect();
            [created]
                .into_iter()
                .filter(|text| !text.is_empty())
                .chain(grants)
                .collect::<Vec<_>>()
                .join("\n")
        }
        _ => return Err(unknown()),
    };
    Ok(Ddl { sql })
}
