//! A fake of the databases of the modules: it records what it is asked and answers like a
//! driver. A statement with `fail` fails with the password it was given, to test that the
//! application keeps it out of the error.
use super::*;
use crate::ports::{DataSources, SqlConnection, StatementRequest};

#[derive(Default)]
pub(crate) struct FakeSources {
    pub(crate) connected: Mutex<Vec<(String, SqlConnection)>>,
    pub(crate) executed: Mutex<Vec<(String, StatementRequest)>>,
    pub(crate) disconnected: Mutex<Vec<String>>,
    /// Rows written, by session.
    pub(crate) written: Mutex<Vec<(String, Value)>>,
    /// Searches asked for, by session.
    pub(crate) searched: Mutex<Vec<(String, Value)>>,
    /// Batches imported, by session.
    pub(crate) imported: Mutex<Vec<(String, Value)>>,
    /// Plans asked for, by session.
    pub(crate) explained: Mutex<Vec<(String, Value)>>,
    /// Requests of the server's sessions and locks, by session.
    pub(crate) administered: Mutex<Vec<(String, Value)>>,
    /// Sessions kept from closing for being idle, and whether they still are.
    pub(crate) held: Mutex<Vec<(String, bool)>>,
}

#[async_trait]
impl DataSources for FakeSources {
    async fn driver(&self, driver: &str) -> Result<Value> {
        Ok(json!({"driver": {"id": driver}}))
    }
    async fn test(&self, connection: SqlConnection) -> Result<Value> {
        let password = connection.password.clone().unwrap_or_default();
        Ok(json!({"server": {"serverVersion": "16.4", "user": connection.user, "note": password}}))
    }
    async fn connect(&self, session: &str, connection: SqlConnection) -> Result<Value> {
        if connection.host.as_deref() == Some("down.test") {
            return Err(Error::Database {
                code: "auth".into(),
                message: format!(
                    "password {} refused",
                    connection.password.unwrap_or_default()
                ),
                detail: None,
            });
        }
        self.connected
            .lock()
            .unwrap()
            .push((session.into(), connection));
        Ok(json!({"serverVersion": "16.4"}))
    }
    async fn disconnect(&self, session: &str) -> Result<()> {
        self.disconnected.lock().unwrap().push(session.into());
        Ok(())
    }
    async fn tree(&self, _: &str, path: Vec<String>) -> Result<Value> {
        Ok(json!({"nodes": [{"name": path.len().to_string()}]}))
    }
    async fn describe(&self, _: &str, _: Vec<String>) -> Result<Value> {
        Ok(json!({"kind": "table"}))
    }
    async fn ddl(&self, _: &str, _: Vec<String>) -> Result<Value> {
        Ok(json!({"sql": "create table t (id int)"}))
    }
    async fn execute(&self, session: &str, request: StatementRequest) -> Result<Value> {
        let sql = request.sql.clone();
        self.executed
            .lock()
            .unwrap()
            .push((session.into(), request));
        if sql.contains("fail") {
            let connected = self.connected.lock().unwrap();
            let password = connected.last().and_then(|(_, c)| c.password.clone());
            return Err(Error::Database {
                code: "syntax".into(),
                message: format!("near fail (password {})", password.unwrap_or_default()),
                detail: Some(json!({"position": 8})),
            });
        }
        Ok(
            json!({"columns": [{"name": "n"}], "rows": [[1], [2]], "cursor": null, "affected": null}),
        )
    }
    async fn fetch(&self, _: &str, cursor: &str, _: Option<u32>) -> Result<Value> {
        Ok(json!({"rows": [[3]], "cursor": null, "from": cursor}))
    }
    async fn close(&self, _: &str, _: &str) -> Result<()> {
        Ok(())
    }
    async fn cancel(&self, _: &str, _: &str) -> Result<()> {
        Ok(())
    }
    async fn transaction(&self, _: &str, action: &str, _: Option<String>) -> Result<Value> {
        Ok(json!({"autoCommit": action != "manual", "open": action == "begin"}))
    }
    async fn write_rows(&self, session: &str, request: Value) -> Result<Value> {
        let changes = request["changes"].as_array().map_or(0, Vec::len);
        self.written.lock().unwrap().push((session.into(), request));
        Ok(
            json!({"affected": changes, "statements": ["UPDATE \"t\" SET \"a\" = ? WHERE \"id\" = ?"]}),
        )
    }
    async fn ddl_model(&self, _: &str, request: Value) -> Result<Value> {
        Ok(
            json!({"table": {"name": request["path"].as_array().and_then(|p| p.last()).cloned().unwrap_or_default(), "columns": []}, "types": ["integer", "text"]}),
        )
    }
    async fn ddl_plan(&self, _: &str, request: Value) -> Result<Value> {
        let sql = if request["target"].is_null() {
            "DROP TABLE t"
        } else {
            "ALTER TABLE t ADD COLUMN c text"
        };
        Ok(json!({"statements": [sql], "warnings": [], "transactional": true}))
    }
    async fn search(&self, session: &str, request: Value) -> Result<Value> {
        self.searched
            .lock()
            .unwrap()
            .push((session.into(), request));
        Ok(json!({"objects": [{"kind": "table", "name": "orders", "path": ["shop", "orders"]}]}))
    }
    async fn import(&self, session: &str, request: Value) -> Result<Value> {
        let rows = request["rows"].as_array().map_or(0, Vec::len);
        self.imported
            .lock()
            .unwrap()
            .push((session.into(), request));
        Ok(json!({"inserted": rows, "upserted": 0, "failed": 0, "failures": []}))
    }
    async fn explain(&self, session: &str, request: Value) -> Result<Value> {
        self.explained
            .lock()
            .unwrap()
            .push((session.into(), request.clone()));
        Ok(json!({
            "mode": request["mode"],
            "nodes": [{"operation": "Seq Scan", "object": "t", "flags": ["full-scan"]}],
            "format": "json",
            "original": "[]",
            "rolledBack": request["mode"] == "actual" && request["writes"] == true,
        }))
    }
    async fn sessions(&self, session: &str, request: Value) -> Result<Value> {
        self.administered
            .lock()
            .unwrap()
            .push((session.into(), request));
        Ok(json!({"sessions": [{"id": "7", "user": "ana", "active": true, "own": true}]}))
    }
    async fn locks(&self, session: &str, request: Value) -> Result<Value> {
        self.administered
            .lock()
            .unwrap()
            .push((session.into(), request));
        Ok(json!({"waits": [{"waiting": "9", "blocking": "8"}]}))
    }
    async fn kill(&self, session: &str, request: Value) -> Result<Value> {
        self.administered
            .lock()
            .unwrap()
            .push((session.into(), request));
        Ok(json!({"done": true}))
    }
    async fn dashboards(&self, session: &str, request: Value) -> Result<Value> {
        self.administered
            .lock()
            .unwrap()
            .push((session.into(), request));
        Ok(
            json!({"dashboards": [{"id": "sessions", "title": "Sessions", "sql": "SELECT 1",
            "chart": "line", "interval": 5}]}),
        )
    }
    async fn hold(&self, session: &str, held: bool) -> Result<()> {
        self.held.lock().unwrap().push((session.into(), held));
        Ok(())
    }
}

/// An application with the fake databases, and a saved connection `c1` of `local` built from
/// `value` (a PostgreSQL one when `value` is empty).
pub(crate) fn with_sources(value: Value) -> (Application, Arc<Fake>, Arc<FakeSources>) {
    let (application, fake) = application();
    let sources = Arc::new(FakeSources::default());
    let application = application.with_datasources(sources.clone());
    let mut connection = json!({
        "driver": "postgres", "host": "{{host}}", "port": 5432, "database": "shop",
        "user": "ana", "password": "{{vault:db-password:c1}}",
    });
    if let (Value::Object(base), Value::Object(changes)) = (&mut connection, value) {
        base.extend(changes);
    }
    fake.documents.lock().unwrap().push(Document {
        id: DocumentId::parse("c1").unwrap(),
        workspace_id: WorkspaceId::parse("local").unwrap(),
        kind: DocumentKind::Connection,
        name: "Shop".into(),
        revision: 1,
        updated_at: 0,
        value: connection,
    });
    (application, fake, sources)
}
