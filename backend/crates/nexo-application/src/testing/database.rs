//! The fake document database: it records connections, queries and writes, and fails like a
//! driver when the URI asks it to.
use super::*;
use crate::vault::uri_encode;

#[async_trait]
impl DocumentDatabase for Fake {
    async fn test(&self, connection: DatabaseConnection) -> Result<ports::ConnectionReport> {
        let failing = connection.uri.contains("fail");
        let password = connection.password.clone().unwrap_or_default();
        self.connections.lock().unwrap().push(connection);
        if failing {
            // As a driver could: the credentials in its message.
            return Err(Error::Validation(format!(
                "Authentication failed for password {password} ({})",
                uri_encode(&password)
            )));
        }
        Ok(ports::ConnectionReport {
            server_version: "8.0.4".into(),
            topology: "standalone".into(),
            replica_set: None,
            flavor: None,
            hosts: vec![],
            ping_ms: 1,
            direct: false,
            tls: false,
            auth_mechanism: None,
        })
    }
    async fn databases(
        &self,
        connection: DatabaseConnection,
    ) -> Result<Vec<ports::DatabaseSummary>> {
        self.connections.lock().unwrap().push(connection);
        Ok(vec![ports::DatabaseSummary {
            name: "shop".into(),
            size_on_disk: Some(4096),
            empty: false,
        }])
    }
    async fn collections(
        &self,
        _: DatabaseConnection,
        database: &str,
    ) -> Result<Vec<ports::CollectionSummary>> {
        Ok(vec![ports::CollectionSummary {
            name: format!("{database}-orders"),
            kind: "collection".into(),
            gridfs: None,
            view_on: None,
            capped: false,
        }])
    }
    async fn stats(
        &self,
        _: DatabaseConnection,
        _: &str,
        _: &str,
    ) -> Result<ports::CollectionStats> {
        Err(Error::NotFound)
    }
    async fn find(
        &self,
        connection: DatabaseConnection,
        request: ports::FindRequest,
    ) -> Result<ports::DocumentPage> {
        let password = connection.password.clone().unwrap_or_default();
        self.finds.lock().unwrap().push(request);
        if connection.uri.contains("fail") {
            return Err(Error::Validation(format!("Query failed for {password}")));
        }
        Ok(ports::DocumentPage {
            documents: vec![json!({"_id": {"$oid": "65a1b2c3d4e5f6a7b8c9d0e1"}})],
            cursor: Some("c1".into()),
            truncated: false,
            elapsed_ms: 2,
        })
    }
    async fn more(&self, cursor: &str, _: &str, _: u64) -> Result<ports::DocumentPage> {
        Err(Error::Validation(format!("Cursor {cursor} closed")))
    }
    async fn count(&self, _: DatabaseConnection, request: ports::CountRequest) -> Result<u64> {
        Ok(request.limit.unwrap_or(7))
    }
    async fn cancel(&self, id: &str) -> Result<bool> {
        Ok(id == "running")
    }
    async fn close(&self, _: &str) -> Result<()> {
        Ok(())
    }
    async fn write(
        &self,
        connection: DatabaseConnection,
        target: ports::WriteTarget,
        write: ports::DocumentWrite,
    ) -> Result<ports::WriteResult> {
        self.connections.lock().unwrap().push(connection);
        self.writes.lock().unwrap().push((target, write.clone()));
        let before = json!({"_id": 1, "n": {"$numberInt": "1"}});
        let after = json!({"_id": 1, "n": {"$numberInt": "2"}});
        Ok(match write {
            ports::DocumentWrite::Restore { changes } => ports::WriteResult {
                matched: changes.len() as u64,
                modified: changes.len() as u64,
                ..Default::default()
            },
            _ => ports::WriteResult {
                matched: 1,
                modified: 1,
                changes: vec![ports::DocumentChange {
                    before: Some(before),
                    after: Some(after),
                }],
                ..Default::default()
            },
        })
    }
    async fn change(
        &self,
        connection: DatabaseConnection,
        _: ports::CollectionChange,
    ) -> Result<()> {
        self.connections.lock().unwrap().push(connection);
        Ok(())
    }
    async fn indexes(
        &self,
        _: DatabaseConnection,
        _: &str,
        collection: &str,
    ) -> Result<Vec<ports::IndexDetail>> {
        Ok(vec![ports::IndexDetail {
            name: format!("{collection}_id_"),
            spec: json!({"key": {"_id": {"$numberInt": "1"}}}),
            size: Some(4096),
            accesses: None,
            since: None,
        }])
    }
    async fn index(
        &self,
        connection: DatabaseConnection,
        change: ports::IndexChange,
    ) -> Result<()> {
        self.connections.lock().unwrap().push(connection);
        self.indexes.lock().unwrap().push(change);
        Ok(())
    }
    async fn explain(
        &self,
        _: DatabaseConnection,
        request: ports::ExplainRequest,
    ) -> Result<Value> {
        self.explains.lock().unwrap().push(request);
        Ok(json!({"queryPlanner": {"winningPlan": {"stage": "COLLSCAN"}}}))
    }
    async fn profile(
        &self,
        _: DatabaseConnection,
        _: &str,
        set: Option<(i64, Option<i64>)>,
    ) -> Result<ports::ProfileStatus> {
        let (level, slowms) = set.unwrap_or((0, None));
        Ok(ports::ProfileStatus {
            level,
            slowms: slowms.unwrap_or(100),
            sample_rate: None,
        })
    }
    async fn profiled(
        &self,
        _: DatabaseConnection,
        database: &str,
        collection: Option<&str>,
        limit: u64,
    ) -> Result<Vec<ports::ProfileEntry>> {
        Ok(vec![ports::ProfileEntry {
            op: "query".into(),
            ns: format!("{database}.{}", collection.unwrap_or("orders")),
            millis: limit as i64,
            ts: None,
            plan_summary: Some("COLLSCAN".into()),
            docs_examined: None,
            keys_examined: None,
            returned: None,
            command: None,
        }])
    }
}
