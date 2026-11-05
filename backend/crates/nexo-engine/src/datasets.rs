//! Datasets: JSON or CSV rows stored per owner and queried with read-only SQL.
use crate::hex;
use crate::vault::write_atomic;
use aws_lc_rs::digest;
use nexo_domain::{Error, Result};
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

/// Parses JSON or CSV content (or `rows`) into objects.
pub fn parse_rows(payload: &Value) -> Result<Vec<Map<String, Value>>> {
    let rows = match (&payload["rows"], payload["content"].as_str()) {
        (Value::Array(_), _) => payload["rows"].clone(),
        (_, Some(content)) => {
            let text = content.trim();
            if text.starts_with('[') || text.starts_with('{') {
                serde_json::from_str(text)
                    .map_err(|error| invalid(format!("Invalid JSON dataset: {error}")))?
            } else {
                Value::Array(parse_csv(content)?.into_iter().map(Value::Object).collect())
            }
        }
        _ => Value::Null,
    };
    let Value::Array(rows) = rows else {
        return Err(invalid(
            "Dataset must contain an array with at most 100,000 rows",
        ));
    };
    if rows.len() > MAX_ROWS {
        return Err(invalid(
            "Dataset must contain an array with at most 100,000 rows",
        ));
    }
    rows.into_iter()
        .map(|row| match row {
            Value::Object(object) => Ok(object),
            _ => Err(invalid("Every dataset row must be an object")),
        })
        .collect()
}

/// Numbers are inferred only when converting back gives the same text: `01234` stays text.
fn infer(value: &str) -> Value {
    let digits = value.strip_prefix('-').unwrap_or(value);
    let (integer, fraction) = digits
        .split_once('.')
        .map_or((digits, None), |(i, f)| (i, Some(f)));
    let valid = !integer.is_empty()
        && integer.bytes().all(|b| b.is_ascii_digit())
        && (integer == "0" || !integer.starts_with('0'))
        && fraction.is_none_or(|f| !f.is_empty() && f.bytes().all(|b| b.is_ascii_digit()));
    if !valid {
        return json!(value);
    }
    if fraction.is_none() {
        return match value.parse::<i64>() {
            Ok(number) if number.unsigned_abs() < (1u64 << 53) && number.to_string() == value => {
                json!(number)
            }
            _ => json!(value),
        };
    }
    match value.parse::<f64>() {
        Ok(number) if number.is_finite() && number.to_string() == value => json!(number),
        _ => json!(value),
    }
}
pub fn parse_csv(text: &str) -> Result<Vec<Map<String, Value>>> {
    let mut records: Vec<Vec<String>> = Vec::new();
    let (mut row, mut field, mut quoted) = (Vec::new(), String::new(), false);
    let mut characters = text.chars().peekable();
    while let Some(c) = characters.next() {
        match c {
            '"' if quoted && characters.peek() == Some(&'"') => {
                field.push('"');
                characters.next();
            }
            '"' => quoted = !quoted,
            ',' if !quoted => row.push(std::mem::take(&mut field)),
            '\n' | '\r' if !quoted => {
                if c == '\r' && characters.peek() == Some(&'\n') {
                    characters.next();
                }
                row.push(std::mem::take(&mut field));
                let record = std::mem::take(&mut row);
                if record.iter().any(|f| !f.is_empty()) {
                    records.push(record);
                }
            }
            _ => field.push(c),
        }
    }
    row.push(field);
    if row.iter().any(|f| !f.is_empty()) {
        records.push(row);
    }
    if quoted {
        return Err(invalid("Unclosed CSV quote"));
    }
    let mut records = records.into_iter();
    let headers: Vec<String> = records
        .next()
        .unwrap_or_default()
        .into_iter()
        .map(|name| name.trim_start_matches('\u{feff}').to_string())
        .collect();
    Ok(records
        .map(|values| {
            headers
                .iter()
                .enumerate()
                .map(|(index, name)| {
                    (
                        name.clone(),
                        infer(values.get(index).map(String::as_str).unwrap_or("")),
                    )
                })
                .collect()
        })
        .collect())
}
fn infrastructure(error: impl std::fmt::Display) -> Error {
    Error::Infrastructure(error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn csv_keeps_text_that_looks_numeric() {
        let rows = parse_csv(
            "\u{feff}id,code,price,name\r\n1,01234,2.50,\"a, \"\"b\"\"\"\n2,-0,3.5,c\n\n",
        )
        .unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0]["id"], 1);
        assert_eq!(rows[0]["code"], "01234");
        assert_eq!(rows[0]["price"], "2.50");
        assert_eq!(rows[0]["name"], "a, \"b\"");
        assert_eq!(rows[1]["code"], "-0");
        assert_eq!(rows[1]["price"], 3.5);
        assert!(parse_csv("a\n\"open").is_err());
    }
    #[test]
    fn queries_are_read_only_and_scoped() {
        let directory =
            std::env::temp_dir().join(format!("nexo-datasets-{}", uuid::Uuid::new_v4()));
        let datasets = Datasets::new(directory.clone());
        let imported = datasets
            .import(&json!({"id": "d", "scope": "workspace:a", "content": "[{\"n\":1,\"ok\":true},{\"n\":2,\"tags\":[1]}]"}))
            .unwrap();
        assert_eq!(imported["columns"], json!(["n", "ok", "tags"]));
        let result = datasets
            .query(&json!({"id": "d", "scope": "workspace:a", "sql": "SELECT n, ok, tags FROM data ORDER BY n DESC;"}))
            .unwrap();
        assert_eq!(
            result["rows"],
            json!([{"n": 2, "ok": null, "tags": "[1]"}, {"n": 1, "ok": 1, "tags": null}])
        );
        assert!(
            datasets
                .query(&json!({"id": "d", "scope": "workspace:b"}))
                .is_err()
        );
        for sql in [
            "DELETE FROM data",
            "SELECT 1; DROP TABLE data",
            "ATTACH DATABASE 'x.db' AS x",
            "PRAGMA table_info(data)",
            "CREATE TABLE t(a)",
        ] {
            assert!(
                datasets
                    .query(&json!({"id": "d", "scope": "workspace:a", "sql": sql}))
                    .is_err(),
                "{sql}"
            );
        }
        let slow = datasets
            .query(&json!({"id": "d", "scope": "workspace:a",
                "sql": "WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c) SELECT count(*) FROM c"}))
            .unwrap_err();
        assert!(slow.to_string().contains("5 second"), "{slow}");
        datasets
            .remove(&json!({"id": "d", "scope": "workspace:a"}))
            .unwrap();
        assert!(
            datasets
                .query(&json!({"id": "d", "scope": "workspace:a"}))
                .is_err()
        );
        let _ = std::fs::remove_dir_all(directory);
    }
}
