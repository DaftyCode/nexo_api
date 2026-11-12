//! Datasets: JSON or CSV rows stored per owner and queried with read-only SQL.

mod parse;

use crate::hex;
use crate::vault::write_atomic;
use aws_lc_rs::digest;
use nexo_domain::{Error, Result};
pub use parse::{parse_csv, parse_rows};
use rusqlite::{
    Connection, ToSql,
    hooks::{AuthAction, AuthContext, Authorization},
    types::{Null, ValueRef},
};
use serde_json::{Map, Value, json};
use std::{
    path::PathBuf,
    time::{Duration, Instant},
};

const MAX_ROWS: usize = 100_000;
const MAX_RESULT_ROWS: usize = 10_000;
const QUERY_TIMEOUT: Duration = Duration::from_secs(5);

fn invalid(message: impl Into<String>) -> Error {
    Error::Validation(message.into())
}

pub struct Datasets {
    directory: PathBuf,
}
impl Datasets {
    pub fn new(directory: PathBuf) -> Self {
        Self { directory }
    }
    /// Owner is the workspace scope the application set, or the local user.
    fn path(&self, payload: &Value, id: &str) -> PathBuf {
        let owner = payload["scope"]
            .as_str()
            .filter(|s| !s.is_empty())
            .unwrap_or("local");
        let name = hex::encode(digest::digest(
            &digest::SHA256,
            format!("{owner}:{id}").as_bytes(),
        ));
        self.directory.join(format!("{name}.json"))
    }
    fn id(payload: &Value) -> Result<String> {
        match &payload["id"] {
            Value::String(id) if !id.is_empty() && id.len() <= 160 => Ok(id.clone()),
            _ => Err(invalid("Invalid dataset identifier")),
        }
    }
    pub fn import(&self, payload: &Value) -> Result<Value> {
        let rows = parse_rows(payload)?;
        let id = if payload["id"].is_null() {
            uuid::Uuid::new_v4().to_string()
        } else {
            Self::id(payload)?
        };
        std::fs::create_dir_all(&self.directory).map_err(infrastructure)?;
        let text = serde_json::to_vec(&rows).map_err(infrastructure)?;
        write_atomic(&self.path(payload, &id), &text)?;
        Ok(json!({"id": id, "rows": rows.len(), "columns": columns(&rows)}))
    }
    pub fn remove(&self, payload: &Value) -> Result<Value> {
        let path = self.path(payload, &Self::id(payload)?);
        match std::fs::remove_file(path) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(infrastructure(error)),
        }
        Ok(json!({"deleted": true}))
    }
    pub fn query(&self, payload: &Value) -> Result<Value> {
        let text = match std::fs::read(self.path(payload, &Self::id(payload)?)) {
            Ok(text) => text,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Err(invalid("Dataset not found; import it again"));
            }
            Err(error) => return Err(infrastructure(error)),
        };
        let rows: Vec<Map<String, Value>> =
            serde_json::from_slice(&text).map_err(infrastructure)?;
        let sql = payload["sql"]
            .as_str()
            .unwrap_or("SELECT * FROM data LIMIT 100");
        query(&rows, sql)
    }
}

/// Loads rows into an in-memory table and runs one read-only statement with a time limit.
pub fn query(rows: &[Map<String, Value>], sql: &str) -> Result<Value> {
    let columns = columns(rows);
    if columns.is_empty() {
        return Ok(json!({"columns": [], "rows": []}));
    }
    let sql = sql.trim();
    if sql
        .trim_end_matches(|c: char| c == ';' || c.is_whitespace())
        .contains(';')
    {
        return Err(invalid("Only a single read-only SELECT query is supported"));
    }
    let mut db = Connection::open_in_memory().map_err(infrastructure)?;
    let quote = |name: &str| format!("\"{}\"", name.replace('"', "\"\""));
    db.execute_batch(&format!(
        "CREATE TABLE data ({})",
        columns
            .iter()
            .map(|c| quote(c))
            .collect::<Vec<_>>()
            .join(",")
    ))
    .map_err(infrastructure)?;
    {
        let transaction = db.transaction().map_err(infrastructure)?;
        {
            let placeholders = vec!["?"; columns.len()].join(",");
            let mut insert = transaction
                .prepare(&format!("INSERT INTO data VALUES ({placeholders})"))
                .map_err(infrastructure)?;
            for row in rows {
                let values: Vec<Box<dyn ToSql>> = columns
                    .iter()
                    .map(|column| sql_value(row.get(column)))
                    .collect();
                insert
                    .execute(rusqlite::params_from_iter(
                        values.iter().map(|v| v.as_ref()),
                    ))
                    .map_err(infrastructure)?;
            }
        }
        transaction.commit().map_err(infrastructure)?;
    }
    db.execute_batch("PRAGMA query_only=ON")
        .map_err(infrastructure)?;
    // Only reads and SQL functions: no ATTACH, PRAGMA, writes or schema changes.
    db.authorizer(Some(|context: AuthContext<'_>| match context.action {
        AuthAction::Select
        | AuthAction::Read { .. }
        | AuthAction::Function { .. }
        | AuthAction::Recursive => Authorization::Allow,
        _ => Authorization::Deny,
    }))
    .map_err(infrastructure)?;
    let deadline = Instant::now() + QUERY_TIMEOUT;
    db.progress_handler(10_000, Some(move || Instant::now() > deadline))
        .map_err(infrastructure)?;
    let mut statement = db.prepare(sql).map_err(|error| {
        let message = error.to_string();
        if message.contains("not authorized") {
            invalid("Only a single read-only SELECT query is supported")
        } else {
            invalid(message)
        }
    })?;
    if !statement.readonly() {
        return Err(invalid("Only a single read-only SELECT query is supported"));
    }
    let names: Vec<String> = statement.column_names().map(String::from).collect();
    let mut result = Vec::new();
    let mut cursor = statement.query([]).map_err(sql_error)?;
    while let Some(row) = cursor.next().map_err(sql_error)? {
        let mut object = Map::new();
        for (index, name) in names.iter().enumerate() {
            object.insert(
                name.clone(),
                json_value(row.get_ref(index).map_err(sql_error)?),
            );
        }
        result.push(Value::Object(object));
        if result.len() >= MAX_RESULT_ROWS {
            break;
        }
    }
    Ok(json!({
        "columns": if result.is_empty() { columns } else { names },
        "truncated": result.len() >= MAX_RESULT_ROWS,
        "rows": result,
        "totalRows": rows.len(),
    }))
}
fn sql_error(error: rusqlite::Error) -> Error {
    if matches!(&error, rusqlite::Error::SqliteFailure(code, _) if code.code == rusqlite::ErrorCode::OperationInterrupted)
    {
        return invalid("Dataset query exceeded the 5 second limit");
    }
    invalid(error.to_string())
}
fn sql_value(value: Option<&Value>) -> Box<dyn ToSql> {
    match value {
        None | Some(Value::Null) => Box::new(Null),
        Some(Value::Bool(flag)) => Box::new(i64::from(*flag)),
        Some(Value::Number(number)) => match number.as_i64() {
            Some(integer) => Box::new(integer),
            None => Box::new(number.as_f64().unwrap_or_default()),
        },
        Some(Value::String(text)) => Box::new(text.clone()),
        Some(other) => Box::new(other.to_string()),
    }
}
fn json_value(value: ValueRef<'_>) -> Value {
    match value {
        ValueRef::Null => Value::Null,
        ValueRef::Integer(integer) => json!(integer),
        ValueRef::Real(real) => json!(real),
        ValueRef::Text(text) => json!(String::from_utf8_lossy(text)),
        ValueRef::Blob(blob) => json!(hex::encode(blob)),
    }
}
fn columns(rows: &[Map<String, Value>]) -> Vec<String> {
    let mut columns: Vec<String> = Vec::new();
    for row in rows {
        for key in row.keys() {
            if !columns.contains(key) {
                columns.push(key.clone());
            }
        }
    }
    columns
}

fn infrastructure(error: impl std::fmt::Display) -> Error {
    Error::Infrastructure(error.to_string())
}

#[cfg(test)]
mod tests;
