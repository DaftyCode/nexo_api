//! The Apache Hive module (DB-42): HiveServer2 in HTTP mode (Thrift over HTTP, the
//! `TCLIService` protocol), with a user and a password, through the SDK's HTTP client: each
//! node resolved by the host, TLS with aws-lc-rs. Kerberos is not supported. Statements run
//! asynchronously, so they can be cancelled, and their rows are read a page at a time from
//! the cursor HiveServer2 keeps. The tree lists databases, tables and views, and columns.
//!
//! The design of the drivers is in `docs/ARCHITECTURE.md`, section "Database modules".
mod catalog;
mod operations;
mod rows;
mod session;
mod statements;
mod thrift;

use async_trait::async_trait;
use nexo_driver_sdk::{
    Column, Driver, DriverError, HostLink, PROTOCOL_VERSION, Result,
    explain::{ExplainMode, ExplainParams, Plan},
    limits,
    protocol::{
        Capabilities, ConnectParams, Ddl, Dialect, DriverInfo, Hello, ObjectDescription,
        ObjectParams, ServerInfo, TestReport, TreeNode,
    },
    statements::{CancelParams, CursorParams, ExecuteParams, ExecuteResult, FetchParams, Page},
};
use operations::Operation;
use session::Session;
use std::{
    collections::HashMap,
    sync::{
        Arc, Mutex,
        atomic::{AtomicU64, Ordering},
    },
    time::Instant,
};

/// The settings a Hive connection accepts, besides the common ones: its HTTP path.
pub const SETTINGS: [&str; 1] = ["httpPath"];

/// An open result: its operation on the server and its columns.
struct Cursor {
    operation: Operation,
    columns: Vec<Column>,
}

struct HiveConnection {
    session: Session,
    cursors: Mutex<HashMap<String, Cursor>>,
    /// The operations running, by the name the editor gave their statement, to cancel them.
    running: Mutex<HashMap<String, Operation>>,
}

#[derive(Default)]
pub struct HiveDriver {
    connections: Mutex<HashMap<String, Arc<HiveConnection>>>,
    cursors: AtomicU64,
}

fn not_open() -> DriverError {
    DriverError::invalid("The connection is not open")
}
fn closed_result() -> DriverError {
    DriverError::invalid("The result was closed: run it again")
}

impl HiveDriver {
    fn connection(&self, name: &str) -> Result<Arc<HiveConnection>> {
        self.connections
            .lock()
            .unwrap()
            .get(name)
            .cloned()
            .ok_or_else(not_open)
    }
    fn keep(&self, connection: &HiveConnection, cursor: Cursor) -> Result<String> {
        let mut cursors = connection.cursors.lock().unwrap();
        if cursors.len() >= limits::CURSORS {
            return Err(DriverError::invalid(
                "Too many results are still open: close some",
            ));
        }
        let id = format!("c{}", self.cursors.fetch_add(1, Ordering::Relaxed) + 1);
        cursors.insert(id.clone(), cursor);
        Ok(id)
    }
}

#[async_trait]
impl Driver for HiveDriver {
    fn hello(&self) -> Hello {
        Hello {
            protocol: PROTOCOL_VERSION,
            driver: DriverInfo {
                id: "hive".into(),
                name: "Apache Hive".into(),
                version: env!("CARGO_PKG_VERSION").into(),
            },
            capabilities: Capabilities {
                schemas: false,
                cancel: true,
                explain: vec![ExplainMode::Estimated],
                ..Capabilities::default()
            },
            dialect: Dialect {
                name: "hive".into(),
                quote_open: "`".into(),
                quote_close: "`".into(),
                ..Dialect::default()
            },
        }
    }

    async fn connect(&self, host: &HostLink, params: ConnectParams) -> Result<ServerInfo> {
        if self.connections.lock().unwrap().len() >= limits::CONNECTIONS {
            return Err(DriverError::invalid("Too many Hive connections are open"));
        }
        let session =
            limits::opening(params.connect_timeout_ms, Session::open(host, &params)).await?;
        let info = statements::server(&session, &params).await?;
        let connection = HiveConnection {
            session,
            cursors: Mutex::new(HashMap::new()),
            running: Mutex::new(HashMap::new()),
        };
        self.connections
            .lock()
            .unwrap()
            .insert(params.connection.clone(), Arc::new(connection));
        Ok(info)
    }

    async fn disconnect(&self, connection: &str) -> Result<()> {
        let removed = self.connections.lock().unwrap().remove(connection);
        let connection = removed.ok_or_else(not_open)?;
        connection.session.close().await;
        Ok(())
    }

    async fn test(&self, host: &HostLink, params: ConnectParams) -> Result<TestReport> {
        let started = Instant::now();
        let session =
            limits::opening(params.connect_timeout_ms, Session::open(host, &params)).await?;
        let info = statements::server(&session, &params).await;
        session.close().await;
        Ok(TestReport {
            server: info?,
            ping_ms: started.elapsed().as_millis() as u64,
        })
    }

    async fn tree(&self, params: ObjectParams) -> Result<Vec<TreeNode>> {
        catalog::tree(&self.connection(&params.connection)?.session, &params.path).await
    }
    async fn describe(&self, params: ObjectParams) -> Result<ObjectDescription> {
        catalog::describe(&self.connection(&params.connection)?.session, &params.path).await
    }
    async fn ddl(&self, params: ObjectParams) -> Result<Ddl> {
        catalog::ddl(&self.connection(&params.connection)?.session, &params.path).await
    }

    async fn execute(&self, params: ExecuteParams) -> Result<ExecuteResult> {
        let connection = self.connection(&params.connection)?;
        if !params.params.is_empty() {
            return Err(DriverError::invalid(
                "HiveServer2 takes no parameters: write the values in the statement",
            ));
        }
        let started = Instant::now();
        let sql = params.sql.trim().trim_end_matches(';').to_owned();
        statements::refuse_server_commands(&sql)?;
        let session = &connection.session;
        let operation = session.start(&sql).await?;
        connection
            .running
            .lock()
            .unwrap()
            .insert(params.statement.clone(), operation.clone());
        let waited = session.wait(&operation).await;
        connection.running.lock().unwrap().remove(&params.statement);
        if let Err(error) = waited {
            session.close_operation(&operation).await;
            return Err(error);
        }
        if !operation.has_rows {
            session.close_operation(&operation).await;
            return Ok(ExecuteResult {
                elapsed_ms: started.elapsed().as_millis() as u64,
                ..ExecuteResult::default()
            });
        }
        let columns = session.columns(&operation).await?;
        let rows = limits::page_rows(params.page_rows);
        let (found, more) = session.fetch(&operation, &columns, rows).await?;
        let cursor = if more {
            Some(self.keep(
                &connection,
                Cursor {
                    operation,
                    columns: columns.clone(),
                },
            )?)
        } else {
            session.close_operation(&operation).await;
            None
        };
        Ok(ExecuteResult {
            columns,
            rows: found,
            cursor,
            elapsed_ms: started.elapsed().as_millis() as u64,
            ..ExecuteResult::default()
        })
    }

    async fn fetch(&self, params: FetchParams) -> Result<Page> {
        let connection = self.connection(&params.connection)?;
        let cursor = connection
            .cursors
            .lock()
            .unwrap()
            .remove(&params.cursor)
            .ok_or_else(closed_result)?;
        let rows = limits::page_rows(params.page_rows);
        let session = &connection.session;
        let (found, more) = session
            .fetch(&cursor.operation, &cursor.columns, rows)
            .await?;
        let next = if more && !found.is_empty() {
            Some(self.keep(&connection, cursor)?)
        } else {
            session.close_operation(&cursor.operation).await;
            None
        };
        Ok(Page {
            rows: found,
            cursor: next,
        })
    }

    async fn close(&self, params: CursorParams) -> Result<()> {
        let connection = self.connection(&params.connection)?;
        let removed = connection.cursors.lock().unwrap().remove(&params.cursor);
        let cursor = removed.ok_or_else(closed_result)?;
        connection.session.close_operation(&cursor.operation).await;
        Ok(())
    }

    async fn cancel(&self, params: CancelParams) -> Result<()> {
        let connection = self.connection(&params.connection)?;
        let running = connection
            .running
            .lock()
            .unwrap()
            .get(&params.statement)
            .cloned();
        match running {
            Some(operation) => connection.session.cancel(&operation).await,
            None => Ok(()),
        }
    }

    async fn explain(&self, params: ExplainParams) -> Result<Plan> {
        let connection = self.connection(&params.connection)?;
        statements::explain(&connection.session, &params.sql).await
    }
}

#[cfg(test)]
mod tests;
