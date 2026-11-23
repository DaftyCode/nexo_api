//! The Apache Ignite 3 module (DB-43): Ignite's client protocol (port 10800) written in
//! Rust, as its Java, .NET and C++ clients speak it: MessagePack messages, rows as
//! `BinaryTuple`, a node at the address the host resolved, TLS with aws-lc-rs and Ignite's
//! `basic` authentication. Statements run with the server's cursor, a page at a time, and can
//! be cancelled on their own connection; transactions are Ignite's. The tree lists schemas,
//! tables with their zone, system views and columns from the system views of Ignite 3.1.
//!
//! The design of the drivers is in `docs/ARCHITECTURE.md`, section "Database modules".
mod admin;
mod catalog;
mod client;
mod connection;
mod msgpack;
mod sql;
mod statements;
mod tuple;
mod values;

use async_trait::async_trait;
use client::Client;
use connection::{Connection, Cursor};
use nexo_driver_sdk::{
    Driver, DriverError, HostLink, PROTOCOL_VERSION, Result,
    admin::{AdminParams, KillMode, KillParams, Killed, SessionList},
    explain::{ExplainMode, ExplainParams, Plan},
    limits, methods,
    protocol::{
        Capabilities, ConnectParams, Ddl, Dialect, DriverInfo, Hello, ObjectDescription,
        ObjectParams, ServerInfo, TestReport, TreeNode,
    },
    statements::{
        CancelParams, CursorParams, ExecuteParams, ExecuteResult, FetchParams, Page,
        TransactionParams, TransactionState,
    },
};
use std::{
    collections::HashMap,
    sync::{
        Arc, Mutex,
        atomic::{AtomicU64, Ordering},
    },
    time::Instant,
};

/// The settings an Ignite connection accepts, besides the common ones: the time zone of its
/// session (`UTC` when not said).
pub const SETTINGS: [&str; 1] = ["timeZone"];

#[derive(Default)]
pub struct IgniteDriver {
    connections: Mutex<HashMap<String, Arc<Connection>>>,
    cursors: AtomicU64,
}

fn not_open() -> DriverError {
    DriverError::invalid("The connection is not open")
}
fn closed_result() -> DriverError {
    DriverError::invalid("The result was closed: run it again")
}

/// The time zone of a session: an IANA name or an offset, nothing else.
fn time_zone(params: &ConnectParams) -> Result<String> {
    if let Some(unknown) = params
        .options
        .keys()
        .find(|key| !SETTINGS.contains(&key.as_str()))
    {
        return Err(DriverError::invalid(format!(
            "Ignite has no setting {unknown}"
        )));
    }
    let zone = params
        .options
        .get("timeZone")
        .map(|zone| zone.trim().to_owned())
        .filter(|zone| !zone.is_empty())
        .unwrap_or_else(|| "UTC".into());
    let valid = zone
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || "/_+-:".contains(c));
    if !valid || zone.len() > 64 {
        return Err(DriverError::invalid(format!("{zone} is not a time zone")));
    }
    Ok(zone)
}

impl IgniteDriver {
    fn connection(&self, name: &str) -> Result<Arc<Connection>> {
        let found = self.connections.lock().unwrap().get(name).cloned();
        found.ok_or_else(not_open)
    }
    fn keep(&self, connection: &Connection, cursor: Cursor) -> Result<String> {
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
    async fn open(host: &HostLink, params: &ConnectParams) -> Result<Connection> {
        let zone = time_zone(params)?;
        let client = limits::opening(params.connect_timeout_ms, Client::open(host, params)).await?;
        let schema = params
            .database
            .clone()
            .filter(|schema| !schema.trim().is_empty());
        Ok(Connection::new(client, schema, zone))
    }
}

#[async_trait]
impl Driver for IgniteDriver {
    fn hello(&self) -> Hello {
        Hello {
            protocol: PROTOCOL_VERSION,
            driver: DriverInfo {
                id: "ignite".into(),
                name: "Apache Ignite".into(),
                version: env!("CARGO_PKG_VERSION").into(),
            },
            capabilities: Capabilities {
                transactions: true,
                schemas: false,
                cancel: true,
                explain: vec![ExplainMode::Estimated],
                methods: vec![methods::SESSIONS.into(), methods::KILL.into()],
                kill: vec![KillMode::Cancel],
                ..Capabilities::default()
            },
            dialect: Dialect {
                name: "ignite".into(),
                quote_open: "\"".into(),
                quote_close: "\"".into(),
                ..Dialect::default()
            },
        }
    }

    async fn connect(&self, host: &HostLink, params: ConnectParams) -> Result<ServerInfo> {
        if self.connections.lock().unwrap().len() >= limits::CONNECTIONS {
            return Err(DriverError::invalid("Too many Ignite connections are open"));
        }
        let connection = Self::open(host, &params).await?;
        let info = statements::server(&connection, &params);
        self.connections
            .lock()
            .unwrap()
            .insert(params.connection.clone(), Arc::new(connection));
        Ok(info)
    }

    async fn disconnect(&self, connection: &str) -> Result<()> {
        let removed = self.connections.lock().unwrap().remove(connection);
        removed.ok_or_else(not_open)?.close_all().await;
        Ok(())
    }

    async fn test(&self, host: &HostLink, params: ConnectParams) -> Result<TestReport> {
        let started = Instant::now();
        let connection = Self::open(host, &params).await?;
        let checked = connection.query("SELECT 1", &[]).await;
        let info = statements::server(&connection, &params);
        connection.close_all().await;
        checked?;
        Ok(TestReport {
            server: info,
            ping_ms: started.elapsed().as_millis() as u64,
        })
    }

    async fn tree(&self, params: ObjectParams) -> Result<Vec<TreeNode>> {
        catalog::tree(&*self.connection(&params.connection)?, &params.path).await
    }
    async fn describe(&self, params: ObjectParams) -> Result<ObjectDescription> {
        catalog::describe(&*self.connection(&params.connection)?, &params.path).await
    }
    async fn ddl(&self, params: ObjectParams) -> Result<Ddl> {
        catalog::ddl(&*self.connection(&params.connection)?, &params.path).await
    }

    async fn execute(&self, params: ExecuteParams) -> Result<ExecuteResult> {
        let connection = self.connection(&params.connection)?;
        let started = Instant::now();
        let sql = params.sql.trim().trim_end_matches(';').trim_end();
        let rows = limits::page_rows(params.page_rows);
        let answer = connection
            .run(&params.statement, sql, &params.params, rows)
            .await?;
        let elapsed_ms = started.elapsed().as_millis() as u64;
        if !answer.has_rows {
            return Ok(ExecuteResult {
                affected: u64::try_from(answer.affected).ok(),
                elapsed_ms,
                ..ExecuteResult::default()
            });
        }
        let columns = answer.fields.iter().map(values::Field::column).collect();
        let mut cursor = Cursor {
            resource: answer.cursor,
            fields: answer.fields,
            rows: answer.rows.into(),
        };
        let first = connection.take(&mut cursor, rows).await?;
        let cursor = if cursor.rows.is_empty() && cursor.resource.is_none() {
            None
        } else {
            Some(self.keep(&connection, cursor)?)
        };
        Ok(ExecuteResult {
            columns,
            rows: first,
            cursor,
            elapsed_ms,
            ..ExecuteResult::default()
        })
    }

    async fn fetch(&self, params: FetchParams) -> Result<Page> {
        let connection = self.connection(&params.connection)?;
        let removed = connection.cursors.lock().unwrap().remove(&params.cursor);
        let mut cursor = removed.ok_or_else(closed_result)?;
        let rows = connection
            .take(&mut cursor, limits::page_rows(params.page_rows))
            .await?;
        let next = if cursor.rows.is_empty() && cursor.resource.is_none() {
            None
        } else {
            Some(self.keep(&connection, cursor)?)
        };
        Ok(Page { rows, cursor: next })
    }

    async fn close(&self, params: CursorParams) -> Result<()> {
        let connection = self.connection(&params.connection)?;
        let removed = connection.cursors.lock().unwrap().remove(&params.cursor);
        connection.close(&removed.ok_or_else(closed_result)?).await;
        Ok(())
    }

    async fn cancel(&self, params: CancelParams) -> Result<()> {
        self.connection(&params.connection)?
            .cancel(&params.statement)
            .await
    }

    async fn transaction(&self, params: TransactionParams) -> Result<TransactionState> {
        if params
            .isolation
            .is_some_and(|level| !level.trim().is_empty())
        {
            return Err(DriverError::unsupported(
                "Ignite's transactions have one isolation: serializable",
            ));
        }
        self.connection(&params.connection)?
            .transaction(params.action)
            .await
    }

    async fn explain(&self, params: ExplainParams) -> Result<Plan> {
        statements::explain(&*self.connection(&params.connection)?, &params.sql).await
    }

    async fn sessions(&self, params: AdminParams) -> Result<SessionList> {
        nexo_driver_sdk::admin::sessions(self, params, &admin::IgniteAdmin).await
    }

    async fn kill(&self, params: KillParams) -> Result<Killed> {
        nexo_driver_sdk::admin::kill(self, params, &admin::IgniteAdmin).await
    }
}

#[cfg(test)]
mod tests;
