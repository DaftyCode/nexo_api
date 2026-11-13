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
