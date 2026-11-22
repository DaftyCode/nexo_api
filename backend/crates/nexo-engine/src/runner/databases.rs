//! `nx.mongo` and `nx.sql` calls of scripts: the engine queues them like `nx.sendRequest` and
//! hands them to the application, which the composition root connects once both exist. The
//! connection is named by the script; its URI and secrets never enter the script's context.
use nexo_application::ports::{ScriptCall, ScriptDatabase, SqlCall};
use nexo_domain::{Error, Result};
use serde_json::{Map, Value};
use std::sync::{
    Arc, OnceLock, Weak,
    atomic::{AtomicBool, AtomicU64, Ordering},
};
use tokio::runtime::Handle;

/// The application's answer to `nx.mongo`, set by the composition root, with the runtime it
/// runs on. Weak, as the application holds the engine.
#[derive(Clone, Default)]
pub struct ScriptDatabases(Arc<OnceLock<(Weak<dyn ScriptDatabase>, Handle)>>);

impl ScriptDatabases {
    /// Connects the application; called from the runtime of the service.
    pub fn connect(&self, databases: Weak<dyn ScriptDatabase>) {
        if let Ok(runtime) = Handle::try_current() {
            let _ = self.0.set((databases, runtime));
        }
    }
    fn get(&self) -> Option<(Arc<dyn ScriptDatabase>, Handle)> {
        let (databases, runtime) = self.0.get()?;
        Some((databases.upgrade()?, runtime.clone()))
    }
}

/// The script's variables, the narrowest scope winning, to fill the connection's URI.
pub(crate) fn variables(state: &Value) -> Map<String, Value> {
    let mut variables = Map::new();
    for scope in ["globals", "collection", "environment", "data", "local"] {
        if let Some(values) = state[scope].as_object() {
            variables.extend(values.clone());
        }
    }
    variables
}

/// A queued `nx.mongo` call, answered by the application.
pub(crate) async fn call(
    databases: &ScriptDatabases,
    workspace: &str,
    variables: Map<String, Value>,
    call: &Value,
    confirm: Option<String>,
) -> Result<Value> {
    let (databases, runtime) = databases.get().ok_or_else(|| {
        Error::Validation("nx.mongo is not available here: run the request in Nexo".into())
    })?;
    let text = |key: &str| call[key].as_str().unwrap_or_default().to_string();
    let call = ScriptCall {
        workspace: if workspace.is_empty() {
            "local".into()
        } else {
            workspace.into()
        },
        connection: text("connection"),
        variables,
        database: text("database"),
        collection: text("collection"),
        method: text("method"),
        arguments: call["arguments"].as_array().cloned().unwrap_or_default(),
        confirm,
    };
    // On the service's runtime: scripts run on runtimes of their own, which end with them,
    // and the database connections they open must outlive them.
    runtime
        .spawn(async move { databases.script_call(call).await })
        .await
        .map_err(|error| Error::Infrastructure(error.to_string()))?
}

/// Names the executions of scripts, never the same twice in a process.
static RUNS: AtomicU64 = AtomicU64::new(0);

/// The `nx.sql` sessions of one execution of a request's scripts (DB-32): one per connection
/// it names, closed when it ends, however it ends (a transaction left open is undone).
pub(crate) struct SqlRun {
    databases: ScriptDatabases,
    id: String,
    used: AtomicBool,
}

impl SqlRun {
    pub(crate) fn new(databases: &ScriptDatabases) -> Self {
        Self {
            databases: databases.clone(),
            id: format!("r{}", RUNS.fetch_add(1, Ordering::Relaxed) + 1),
            used: AtomicBool::new(false),
        }
    }

    /// A queued `nx.sql` call, answered by the application on the sessions of this run.
    pub(crate) async fn call(
        &self,
        workspace: &str,
        variables: Map<String, Value>,
        call: &Value,
    ) -> Result<Value> {
        let (databases, runtime) = self.databases.get().ok_or_else(|| {
            Error::Validation("nx.sql is not available here: run the request in Nexo".into())
        })?;
        self.used.store(true, Ordering::Relaxed);
        let text = |key: &str| call[key].as_str().unwrap_or_default().to_string();
        let call = SqlCall {
            workspace: if workspace.is_empty() {
                "local".into()
            } else {
                workspace.into()
            },
            run: self.id.clone(),
            connection: text("connection"),
            variables,
            method: text("method"),
            sql: text("sql"),
            params: call["params"].as_array().cloned().unwrap_or_default(),
            confirm: call["confirm"].clone(),
        };
        runtime
            .spawn(async move { databases.sql_call(call).await })
            .await
            .map_err(|error| Error::Infrastructure(error.to_string()))?
    }
}

impl Drop for SqlRun {
    fn drop(&mut self) {
        if !self.used.load(Ordering::Relaxed) {
            return;
        }
        if let Some((databases, runtime)) = self.databases.get() {
            let id = std::mem::take(&mut self.id);
            runtime.spawn(async move { databases.sql_end(&id).await });
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn the_narrowest_scope_wins() {
        let state = json!({
            "globals": {"host": "g", "a": "1"},
            "environment": {"host": "e"},
            "local": {"host": "l"},
            "data": {"b": "2"},
        });
        assert_eq!(
            Value::Object(variables(&state)),
            json!({"host": "l", "a": "1", "b": "2"})
        );
    }
}
