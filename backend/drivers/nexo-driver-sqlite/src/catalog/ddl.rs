//! The DDL of an object: the statement `sqlite_schema` keeps for it, as it was written, ended
//! with `;`. A table comes with its indexes and triggers; an index SQLite made for a key has
//! no statement of its own.
use super::{query, text, unknown};
use crate::connection::SqliteConnection;
use nexo_driver_sdk::{Result, protocol::Ddl};

fn ended(sql: &str) -> String {
    format!("{};", sql.trim_end().trim_end_matches(';'))
}

pub(crate) async fn ddl(connection: &SqliteConnection, path: &[String]) -> Result<Ddl> {
    let segments: Vec<&str> = path.iter().map(String::as_str).collect();
    let name = match segments.as_slice() {
        ["tables" | "views" | "indexes" | "triggers", name]
        | ["tables" | "views", _, "indexes" | "triggers", name] => *name,
        _ => return Err(unknown()),
    };
    let rows = query(
        connection,
        "SELECT type, sql FROM sqlite_schema WHERE name = ?",
        &[name],
    )
    .await?;
    let row = rows.rows.first().ok_or_else(unknown)?;
    let (kind, sql) = (text(row, 0), text(row, 1));
    if sql.is_empty() {
        return Ok(Ddl {
            sql: format!(
                "-- SQLite made {name} for a key of its {kind}: it has no statement of its own."
            ),
        });
    }
    let mut parts = vec![ended(&sql)];
    if kind == "table" {
        let attached = query(
            connection,
            "SELECT sql FROM sqlite_schema WHERE tbl_name = ? AND type IN ('index', 'trigger') \
             AND sql IS NOT NULL ORDER BY type, name",
            &[name],
        )
        .await?;
        parts.extend(attached.rows.iter().map(|row| ended(&text(row, 0))));
    }
    Ok(Ddl {
        sql: parts.join("\n\n"),
    })
}
