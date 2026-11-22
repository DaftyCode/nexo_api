//! `nx.sql` in scripts (DB-32): each call becomes the `db.*` operation the SQL editor would
//! send, on a saved connection of a database module the script names, so every rule applies
//! (read-only, confirmations, time limit, redaction). Each execution of a script has its own
//! session per connection, committing each statement outside `transaction()`, closed when it
//! ends; a transaction it left open is undone. The script never receives the connection's
//! address, password or certificates, and its parameters are always bound.
use super::sessions::session_name;
use crate::{Application, operations::Operation, ports::SqlCall};
use nexo_domain::{DocumentKind, Error, Result, WorkspaceId};
use serde_json::{Map, Value, json};
use std::sync::atomic::{AtomicU64, Ordering};

/// Rows a query gives a script at most; the answer says when it was cut.
pub const SCRIPT_ROWS: usize = 1_000;
/// Names the statements of scripts, to cancel them.
static STATEMENTS: AtomicU64 = AtomicU64::new(0);

/// The prefix of the sessions of an execution of a script.
fn prefix(run: &str) -> Result<String> {
    let valid = (1..=32).contains(&run.len()) && run.chars().all(|c| c.is_ascii_alphanumeric());
    if valid {
        Ok(format!("script-{run}-"))
    } else {
        Err(Error::Validation("Invalid script run".into()))
    }
}

/// The script's variables as the connection's fields take them: text.
fn texts(variables: &Map<String, Value>) -> Map<String, Value> {
    variables
        .iter()
        .filter(|(_, value)| !value.is_null())
        .map(|(name, value)| {
            let text = value
                .as_str()
                .map_or_else(|| value.to_string(), str::to_owned);
            (name.clone(), Value::String(text))
        })
        .collect()
}

impl Application {
    /// Answers an `nx.sql` call: rows and columns for a query, what it changed otherwise.
    pub(crate) async fn script_sql(&self, call: SqlCall) -> Result<Value> {
        let session = self.script_session(&call).await?;
        match call.method.as_str() {
            "begin" | "commit" | "rollback" => {
                self.datasource(
                    Operation::DbTransaction,
                    json!({"session": session, "action": call.method}),
                )
                .await?;
                Ok(json!({}))
            }
            "query" | "execute" => self.script_statement(&session, call).await,
            other => Err(Error::Validation(format!("Unknown nx.sql call {other}"))),
        }
    }

    /// The session of the execution on the connection the script names, opened on its first
    /// call with the script's variables.
    async fn script_session(&self, call: &SqlCall) -> Result<String> {
        let workspace = WorkspaceId::parse(&call.workspace)?;
        let saved = self
            .workspaces
            .documents(&workspace, Some(DocumentKind::Connection))
            .await?
            .into_iter()
            // MongoDB's connections name no driver, or `mongodb`: they answer `nx.mongo`.
            .filter(|document| {
                document
                    .value
                    .get("driver")
                    .and_then(Value::as_str)
                    .is_some_and(|driver| driver != "mongodb")
            })
            .find(|document| {
                document.id.as_str() == call.connection || document.name == call.connection
            })
            .ok_or_else(|| {
                Error::Validation(format!(
                    "No saved SQL connection is named {}",
                    call.connection
                ))
            })?;
        let session = format!("{}{}", prefix(&call.run)?, saved.id.as_str());
        session_name(&session)?;
        if self.sql_sessions.get(&session).is_ok() {
            return Ok(session);
        }
        let opened = self
            .datasource(
                Operation::DbConnect,
                json!({
                    "workspace": workspace.as_str(),
                    "connectionId": saved.id.as_str(),
                    "session": session,
                    "variables": texts(&call.variables),
                }),
            )
            .await;
        match opened {
            Ok(_) => {}
            Err(Error::Database { code, .. }) if code == "password" => {
                return Err(Error::Validation(
                    "The connection asks for its password each time: a script cannot type it"
                        .into(),
                ));
            }
            Err(error) => return Err(error),
        }
        // A script has no commit button: outside `transaction()` each statement commits.
        let auto = self
            .datasource(
                Operation::DbTransaction,
                json!({"session": session, "action": "auto"}),
            )
            .await;
        if let Err(error) = auto {
            self.close_script_session(&session).await;
            return Err(error);
        }
        Ok(session)
    }

    async fn script_statement(&self, session: &str, call: SqlCall) -> Result<Value> {
        let open = self.sql_sessions.get(session)?;
        if call.method == "execute" && (open.read_only || open.rules.read_only) {
            return Err(Error::Validation(
                "The connection is read-only: a script can only query it".into(),
            ));
        }
        let (confirm, name) = match &call.confirm {
            Value::String(name) => (true, Some(name.clone())),
            Value::Bool(confirm) => (*confirm, None),
            _ => (false, None),
        };
        let statement = format!(
            "{session}-{}",
            STATEMENTS.fetch_add(1, Ordering::Relaxed) + 1
        );
        let mut answer = self
            .datasource(
                Operation::DbExecute,
                json!({
                    "session": session,
                    "statement": statement,
                    "sql": call.sql,
                    "params": call.params,
                    "confirm": confirm,
                    "confirmName": name,
                    "pageRows": SCRIPT_ROWS,
                }),
            )
            .await?;
        let mut rows = answer["rows"].as_array().cloned().unwrap_or_default();
        let mut cursor = answer["cursor"].as_str().map(str::to_owned);
        while let Some(open) = cursor.clone().filter(|_| rows.len() < SCRIPT_ROWS) {
            let page = self
                .datasource(
                    Operation::DbFetch,
                    json!({"session": session, "cursor": open, "pageRows": SCRIPT_ROWS - rows.len()}),
                )
                .await?;
            rows.extend(page["rows"].as_array().cloned().unwrap_or_default());
            cursor = page["cursor"].as_str().map(str::to_owned);
        }
        let truncated = cursor.is_some() || rows.len() > SCRIPT_ROWS;
        rows.truncate(SCRIPT_ROWS);
        if let Some(open) = cursor {
            let _ = self
                .datasource(
                    Operation::DbClose,
                    json!({"session": session, "cursor": open}),
                )
                .await;
        }
        let columns: Vec<Value> = answer["columns"]
            .as_array()
            .into_iter()
            .flatten()
            .map(|column| column["name"].clone())
            .collect();
        Ok(json!({
            "columns": columns,
            "rows": rows,
            "truncated": truncated,
            "affected": answer["affected"].take(),
        }))
    }

    /// Closes the sessions an execution of a script opened; what it left open is undone.
    pub(crate) async fn script_sql_end(&self, run: &str) {
        let Ok(prefix) = prefix(run) else {
            return;
        };
        for (name, _) in self.sql_sessions.all() {
            if name.starts_with(&prefix) {
                self.close_script_session(&name).await;
            }
        }
    }

    async fn close_script_session(&self, session: &str) {
        let _ = self
            .datasource(
                Operation::DbTransaction,
                json!({"session": session, "action": "rollback"}),
            )
            .await;
        let _ = self
            .datasource(Operation::DbDisconnect, json!({"session": session}))
            .await;
    }
}
