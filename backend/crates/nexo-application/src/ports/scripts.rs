//! What scripts may ask of the databases of a workspace. The engine runs the scripts and
//! queues their `nx.mongo` calls; the application answers them with the operations the
//! interface uses, so the same rules apply: a saved connection named by the script, never
//! its URI or password, writes refused on a read-only connection, counts before writes to
//! many documents and the name repeated to empty a collection.
use async_trait::async_trait;
use nexo_domain::Result;
use serde_json::{Map, Value};

/// A call of `nx.mongo(connection).db(database).collection(collection).method(...)`.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct ScriptCall {
    pub workspace: String,
    /// The name of a saved connection of the workspace.
    pub connection: String,
    /// The script's variables, to fill `{{name}}` in the connection's URI and certificates.
    pub variables: Map<String, Value>,
    pub database: String,
    pub collection: String,
    pub method: String,
    /// The arguments, in Extended JSON.
    pub arguments: Vec<Value>,
}

#[async_trait]
pub trait ScriptDatabase: Send + Sync {
    /// The result of a call, in canonical Extended JSON.
    async fn script_call(&self, call: ScriptCall) -> Result<Value>;
}
