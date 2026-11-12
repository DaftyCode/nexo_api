//! `nx.mongo` calls of scripts: the engine queues them like `nx.sendRequest` and hands them
//! to the application, which the composition root connects once both exist. The connection
//! is named by the script; its URI and secrets never enter the script's context.
use nexo_application::ports::{ScriptCall, ScriptDatabase};
use nexo_domain::{Error, Result};
use serde_json::{Map, Value};
use std::sync::{Arc, OnceLock, Weak};

/// The application's answer to `nx.mongo`, set by the composition root. Weak, as the
/// application holds the engine.
#[derive(Clone, Default)]
pub struct ScriptDatabases(Arc<OnceLock<Weak<dyn ScriptDatabase>>>);

impl ScriptDatabases {
    pub fn connect(&self, databases: Weak<dyn ScriptDatabase>) {
        let _ = self.0.set(databases);
    }
    fn get(&self) -> Option<Arc<dyn ScriptDatabase>> {
        self.0.get().and_then(Weak::upgrade)
    }
}

/// The script's variables, the narrowest scope winning, to fill the connection's URI.
fn variables(state: &Value) -> Map<String, Value> {
    let mut variables = Map::new();
    for scope in ["globals", "collection", "environment", "data", "local"] {
        if let Some(values) = state[scope].as_object() {
            variables.extend(values.clone());
        }
    }
    variables
}

/// A queued `nx.mongo` call, answered by the application.
pub(super) async fn call(
    databases: &ScriptDatabases,
    workspace: &str,
    state: &Value,
    call: &Value,
) -> Result<Value> {
    let databases = databases.get().ok_or_else(|| {
        Error::Validation("nx.mongo is not available here: run the request in Nexo".into())
    })?;
    let text = |key: &str| call[key].as_str().unwrap_or_default().to_string();
    databases
        .script_call(ScriptCall {
            workspace: if workspace.is_empty() {
                "local".into()
            } else {
                workspace.into()
            },
            connection: text("connection"),
            variables: variables(state),
            database: text("database"),
            collection: text("collection"),
            method: text("method"),
            arguments: call["arguments"].as_array().cloned().unwrap_or_default(),
        })
        .await
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
