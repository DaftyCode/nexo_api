//! Saved database tasks (`db-task` documents, DB-31): what a task runs (SQL scripts on some
//! connections, a copy of a query into a table of another connection, a comparison of two
//! schemas or tables, a backup with the local client, or other tasks in order), what it
//! authorizes when nobody is there to confirm, and when it runs on its own.
use crate::{Error, Result, monitor::Schedule};
use serde_json::Value;

pub const TASK_TYPES: [&str; 9] = [
    "script",
    "copy",
    "compare",
    "backup",
    "composite",
    // DB-40: a query to a file, a file into a table, and MongoDB's saved transfers and
    // comparisons.
    "export",
    "import",
    "mongo-transfer",
    "mongo-compare",
];
/// The formats of the files of tasks.
pub const FILE_FORMATS: [&str; 3] = ["csv", "json", "jsonl"];
/// What a task may authorize, each one ticked by the person: changes on a connection whose
/// type confirms them (production), statements on every row (`DELETE` without `WHERE`,
/// `TRUNCATE`) and `DROP`.
pub const AUTHORIZATIONS: [&str; 3] = ["writes", "everyRow", "drop"];
/// Scripts, connections and tasks a task names at most.
pub const MAX_ITEMS: usize = 50;

fn invalid(message: &str) -> Error {
    Error::Validation(message.into())
}
fn text<'a>(value: &'a Value, field: &str) -> Option<&'a str> {
    value
        .get(field)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|t| !t.is_empty())
}
/// A list of ids, from one to `MAX_ITEMS`.
fn ids(value: &Value, field: &str, what: &str) -> Result<usize> {
    let list = value
        .get(field)
        .and_then(Value::as_array)
        .ok_or_else(|| invalid(what))?;
    if list.is_empty()
        || list.len() > MAX_ITEMS
        || list
            .iter()
            .any(|id| id.as_str().is_none_or(|id| id.trim().is_empty()))
    {
        return Err(invalid(what));
    }
    Ok(list.len())
}

fn side(value: &Value, field: &str) -> Result<()> {
    let side = value
        .get(field)
        .ok_or_else(|| invalid("A comparison names its two sides"))?;
    if text(side, "connection").is_none() || !side.get("path").is_some_and(Value::is_array) {
        return Err(invalid(
            "Each side of a comparison names its connection and its object",
        ));
    }
    Ok(())
}

/// Checks the value of a `db-task` document.
pub fn validate(value: &Value) -> Result<()> {
    let kind = text(value, "type").unwrap_or_default();
    if !TASK_TYPES.contains(&kind) {
        return Err(invalid(
            "A task runs scripts, a copy, a comparison, a backup, a transfer or other tasks",
        ));
    }
    if let Some(on_error) = text(value, "onError")
        && !["stop", "continue"].contains(&on_error)
    {
        return Err(invalid("After a failure a task stops or goes on"));
    }
    match kind {
        "script" => {
            ids(value, "scripts", "Choose the scripts the task runs")?;
            ids(
                value,
                "connections",
                "Choose the connections the scripts run on",
            )?;
        }
        "copy" => {
            if text(value, "source").is_none() || text(value, "target").is_none() {
                return Err(invalid(
                    "A copy names the connection it reads and the one it writes",
                ));
            }
            if text(value, "sql").is_none() || text(value, "table").is_none() {
                return Err(invalid(
                    "A copy names the query it reads and the table it writes",
                ));
            }
        }
        "compare" => {
            if !["schema", "data"].contains(&text(value, "mode").unwrap_or_default()) {
                return Err(invalid("A comparison compares structure or data"));
            }
            side(value, "source")?;
            side(value, "target")?;
        }
        "backup" => {
            if text(value, "connection").is_none() || text(value, "file").is_none() {
                return Err(invalid(
                    "A backup names its connection and the file it writes",
                ));
            }
        }
        "export" | "import" => {
            if text(value, "connection").is_none() || text(value, "file").is_none() {
                return Err(invalid("A transfer names its connection and its file"));
            }
            if !FILE_FORMATS.contains(&text(value, "format").unwrap_or_default()) {
                return Err(invalid("A file of a task is CSV, JSON or JSON Lines"));
            }
            let (field, what) = if kind == "export" {
                ("sql", "An export names the query it writes")
            } else {
                ("table", "An import names the table it writes")
            };
            if text(value, field).is_none() {
                return Err(invalid(what));
            }
        }
        "mongo-transfer" => {
            if text(value, "transfer").is_none() {
                return Err(invalid("Choose the saved MongoDB transfer the task runs"));
            }
        }
        "mongo-compare" => {
            if text(value, "comparison").is_none() {
                return Err(invalid("Choose the saved MongoDB comparison the task runs"));
            }
        }
        _ => {
            ids(value, "tasks", "Choose the tasks it runs, in order")?;
        }
    }
    if let Some(authorize) = value.get("authorize").filter(|v| !v.is_null()) {
        let Some(map) = authorize.as_object() else {
            return Err(invalid("What a task authorizes is a list of yes or no"));
        };
        if map
            .iter()
            .any(|(key, flag)| !AUTHORIZATIONS.contains(&key.as_str()) || !flag.is_boolean())
        {
            return Err(invalid(
                "A task authorizes changes, statements on every row and DROP",
            ));
        }
    }
    if let Some(schedule) = value.get("schedule").filter(|v| !v.is_null()) {
        Schedule::read(schedule)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::validate;
    use serde_json::json;

    #[test]
    fn a_task_says_what_it_runs_authorizes_and_when() {
        for valid in [
            json!({"type": "script", "scripts": ["s1"], "connections": ["c1", "c2"], "onError": "continue",
                "transaction": true, "authorize": {"writes": true, "everyRow": false},
                "schedule": {"every": 15, "unit": "minutes"}}),
            json!({"type": "copy", "source": "c1", "target": "c2", "sql": "SELECT * FROM t", "table": "t"}),
            json!({"type": "compare", "mode": "data", "source": {"connection": "c1", "path": ["a"]},
                "target": {"connection": "c2", "path": ["b"]}}),
            json!({"type": "backup", "connection": "c1", "file": "C:/backups/shop.sql", "options": {}}),
            json!({"type": "composite", "tasks": ["t1", "t2"], "onError": "stop"}),
            json!({"type": "export", "connection": "c1", "sql": "SELECT 1", "format": "csv",
                "file": "C:/out/{date}.csv", "schedule": {"cron": "0 9 * * mon-fri"}}),
            json!({"type": "import", "connection": "c1", "table": "t", "format": "jsonl", "file": "/in/t.jsonl"}),
            json!({"type": "mongo-transfer", "transfer": "m1", "file": "/out/a.json"}),
            json!({"type": "mongo-compare", "comparison": "m2", "sync": true}),
        ] {
            assert!(validate(&valid).is_ok(), "{valid}");
        }
        for (value, why) in [
            (json!({"type": "magic"}), "runs scripts"),
            (
                json!({"type": "script", "scripts": [], "connections": ["c"]}),
                "Choose the scripts",
            ),
            (
                json!({"type": "script", "scripts": ["s"], "connections": [" "]}),
                "Choose the connections",
            ),
            (
                json!({"type": "copy", "source": "c1", "target": "c2"}),
                "the query it reads",
            ),
            (
                json!({"type": "copy", "sql": "x", "table": "t"}),
                "the connection it reads",
            ),
            (json!({"type": "compare", "mode": "x"}), "structure or data"),
            (
                json!({"type": "compare", "mode": "schema", "source": {"connection": "c"}, "target": {}}),
                "its connection and its object",
            ),
            (
                json!({"type": "compare", "mode": "schema"}),
                "its two sides",
            ),
            (
                json!({"type": "backup", "connection": "c1"}),
                "the file it writes",
            ),
            (
                json!({"type": "composite", "tasks": []}),
                "Choose the tasks",
            ),
            (
                json!({"type": "export", "connection": "c1", "format": "csv"}),
                "its connection and its file",
            ),
            (
                json!({"type": "export", "connection": "c1", "file": "f", "format": "xml"}),
                "CSV, JSON or JSON Lines",
            ),
            (
                json!({"type": "export", "connection": "c1", "file": "f", "format": "csv"}),
                "the query it writes",
            ),
            (
                json!({"type": "import", "connection": "c1", "file": "f", "format": "csv"}),
                "the table it writes",
            ),
            (json!({"type": "mongo-transfer"}), "saved MongoDB transfer"),
            (json!({"type": "mongo-compare"}), "saved MongoDB comparison"),
            (
                json!({"type": "composite", "tasks": ["a"], "onError": "panic"}),
                "stops or goes on",
            ),
            (
                json!({"type": "composite", "tasks": ["a"], "authorize": {"everything": true}}),
                "authorizes changes",
            ),
            (
                json!({"type": "composite", "tasks": ["a"], "authorize": "all"}),
                "yes or no",
            ),
            (
                json!({"type": "composite", "tasks": ["a"], "schedule": {"every": 7, "unit": "minutes"}}),
                "",
            ),
        ] {
            let error = validate(&value).unwrap_err().to_string();
            assert!(error.contains(why), "{value}: {error}");
        }
    }
}
