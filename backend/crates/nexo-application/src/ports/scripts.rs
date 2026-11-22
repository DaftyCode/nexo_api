//! What scripts may ask of the databases of a workspace. The engine runs the scripts and
//! queues their `nx.mongo` and `nx.sql` calls; the application answers them with the operations the
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
    /// The name (or the identifier) of a saved connection of the workspace.
    pub connection: String,
    /// The script's variables, to fill `{{name}}` in the connection's URI and certificates.
    pub variables: Map<String, Value>,
    pub database: String,
    pub collection: String,
    pub method: String,
    /// The arguments, in Extended JSON.
    pub arguments: Vec<Value>,
    /// The name the person typed to confirm a destructive command of the shell (`drop`,
    /// `dropDatabase`, `deleteMany({})`); scripts pass it in the command's options.
    pub confirm: Option<String>,
}

/// A call of `nx.sql(connection).query|execute(sql, params, options)` (DB-32), or the
/// beginning or end of its transaction.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct SqlCall {
    pub workspace: String,
    /// The execution of the script: its sessions are its own and close when it ends.
    pub run: String,
    /// The name (or the identifier) of a saved connection of a database module.
    pub connection: String,
    /// The script's variables, to fill `{{name}}` in the connection.
    pub variables: Map<String, Value>,
    /// `query`, `execute`, `begin`, `commit` or `rollback`.
    pub method: String,
    pub sql: String,
    /// Bound to the statement's markers, as the values of the drivers (`{"$t", "v"}`).
    pub params: Vec<Value>,
    /// What confirms a statement that asks: `true`, or the name a `DROP` asks for.
    pub confirm: Value,
}

#[async_trait]
pub trait ScriptDatabase: Send + Sync {
    /// The result of a call, in canonical Extended JSON.
    async fn script_call(&self, call: ScriptCall) -> Result<Value>;
    /// The answer of an `nx.sql` call: its columns and rows, or what it changed.
    async fn sql_call(&self, _call: SqlCall) -> Result<Value> {
        Err(nexo_domain::Error::Validation(
            "nx.sql is not available here: run the request in Nexo".into(),
        ))
    }
    /// Closes the sessions of a script's execution; a transaction left open is undone.
    async fn sql_end(&self, _run: &str) {}
}
