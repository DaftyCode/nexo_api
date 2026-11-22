//! The Cassandra module (DB-34): Apache Cassandra and ScyllaDB through the ScyllaDB driver,
//! its TLS on rustls with aws-lc-rs. The contact points and every node the driver discovers
//! pass the host's egress policy; CQL runs in the SQL editor with bound parameters and the
//! driver's paging; the tree is read from `system_schema`. Cassandra has no transactions,
//! joins nor plans: the capabilities say so and the interface hides them.
//!
//! The design of the drivers is in `docs/ARCHITECTURE.md`, section "Database modules".
mod catalog;
mod commands;
mod connection;
mod dialect;
mod statement;
mod translator;
mod values;

pub use connection::SETTINGS;

use async_trait::async_trait;
use commands::{Settings, apply, command};
use connection::{rows, text};
use nexo_driver_sdk::{
    Driver, DriverError, HostLink, PROTOCOL_VERSION, Result, limits,
    protocol::{
        Capabilities, ConnectParams, Ddl, DriverInfo, Hello, ObjectDescription, ObjectParams,
        ServerInfo, TestReport, TreeNode,
    },
    statements::{CursorParams, ExecuteParams, ExecuteResult, FetchParams, Page},
};
use scylla::{client::session::Session, response::PagingState, statement::Consistency};
use statement::{Cursor, answer, page, query, read, trace};
use std::{
    collections::HashMap,
    sync::{
        Arc, Mutex,
        atomic::{AtomicU64, Ordering},
    },
    time::Instant,
};

struct CassandraConnection {
    session: Session,
    /// Rows of a page when the editor asks for none.
    page: u32,
    /// The level of the connection, which `CONSISTENCY` changes for the session.
    consistency: Consistency,
    settings: Mutex<Settings>,
    cursors: Mutex<HashMap<String, Cursor>>,
}

#[derive(Default)]
pub struct CassandraDriver {
    connections: Mutex<HashMap<String, Arc<CassandraConnection>>>,
    cursors: AtomicU64,
}

fn not_open() -> DriverError {
    DriverError::invalid("The connection is not open")
}

impl CassandraDriver {
    fn connection(&self, name: &str) -> Result<Arc<CassandraConnection>> {
        self.connections
            .lock()
            .unwrap()
            .get(name)
            .cloned()
            .ok_or_else(not_open)
    }
}

/// What the cluster says of itself: its release, its name, and the data center reached.
async fn server(session: &Session, params: &ConnectParams) -> Result<ServerInfo> {
    let (_, found) = rows(
        session,
        "SELECT release_version, cluster_name, data_center FROM system.local",
        &[],
    )
    .await?;
    let row = found
        .first()
        .ok_or_else(|| DriverError::invalid("The node says nothing of itself"))?;
    Ok(ServerInfo {
        server_version: text(row, 0),
        product: Some(format!("{} ({})", text(row, 1), text(row, 2))),
        database: params.database.clone().filter(|name| !name.is_empty()),
        user: params.user.clone().filter(|user| !user.is_empty()),
        tls: params.tls.mode != nexo_driver_sdk::protocol::TlsMode::Disable,
    })
}

#[async_trait]
impl Driver for CassandraDriver {
    fn hello(&self) -> Hello {
        Hello {
            protocol: PROTOCOL_VERSION,
            driver: DriverInfo {
                id: "cassandra".into(),
                name: "Cassandra and ScyllaDB".into(),
                version: env!("CARGO_PKG_VERSION").into(),
            },
            capabilities: Capabilities {
                transactions: false,
                schemas: true,
                cancel: false,
                read_only_sessions: false,
                ..Capabilities::default()
            },
            dialect: dialect::dialect(),
        }
    }

    async fn connect(&self, host: &HostLink, params: ConnectParams) -> Result<ServerInfo> {
        let name = params.connection.clone();
        if self.connections.lock().unwrap().len() >= limits::CONNECTIONS {
            return Err(DriverError::invalid(
                "Too many Cassandra connections are open",
            ));
        }
        let (session, page, consistency) = connection::open(host, &params).await?;
        let info = server(&session, &params).await?;
        let connection = CassandraConnection {
            session,
            page,
            consistency,
            settings: Mutex::new(Settings::default()),
            cursors: Mutex::new(HashMap::new()),
        };
        self.connections
            .lock()
            .unwrap()
            .insert(name, Arc::new(connection));
        Ok(info)
    }

    async fn disconnect(&self, connection: &str) -> Result<()> {
        let removed = self.connections.lock().unwrap().remove(connection);
        removed.map(|_| ()).ok_or_else(not_open)
    }

    async fn test(&self, host: &HostLink, params: ConnectParams) -> Result<TestReport> {
        let (session, _, _) = connection::open(host, &params).await?;
        let started = Instant::now();
        let info = server(&session, &params).await?;
        let ping_ms = started.elapsed().as_millis() as u64;
        // Every node of the cluster, and whether the policy let the driver reach it.
        for node in session.get_cluster_state().get_nodes_info() {
            let state = if node.is_connected() {
                "connected"
            } else {
                "not connected"
            };
            host.log(
                "info",
                format!(
                    "Node {} · {} / {} · {state}",
                    node.address.ip(),
                    node.datacenter.as_deref().unwrap_or("?"),
                    node.rack.as_deref().unwrap_or("?")
                ),
            )
            .await;
        }
        Ok(TestReport {
            server: info,
            ping_ms,
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
        let started = Instant::now();
        if let Some(command) = command(&params.sql)? {
            let notice = apply(&connection.settings, connection.consistency, command);
            return Ok(ExecuteResult {
                notices: vec![notice],
                elapsed_ms: started.elapsed().as_millis() as u64,
                ..ExecuteResult::default()
            });
        }
        let settings = connection.settings.lock().unwrap().clone();
        let query = query(&connection.session, &params.sql, &params.params, &settings).await?;
        let rows = params.page_rows.unwrap_or(connection.page);
        let (result, next) = page(&connection.session, &query, PagingState::start(), rows).await?;
        let traced = trace(&connection.session, &result).await;
        let cursor = match next {
            Some(paging) => {
                let mut cursors = connection.cursors.lock().unwrap();
                if cursors.len() >= limits::CURSORS {
                    return Err(DriverError::invalid(
                        "Too many results are still open: close some",
                    ));
                }
                let id = format!("c{}", self.cursors.fetch_add(1, Ordering::Relaxed) + 1);
                cursors.insert(id.clone(), Cursor { query, paging });
                Some(id)
            }
            None => None,
        };
        let mut answer = answer(result, cursor, started.elapsed().as_millis() as u64)?;
        answer.notices.extend(traced);
        Ok(answer)
    }

    async fn fetch(&self, params: FetchParams) -> Result<Page> {
        let connection = self.connection(&params.connection)?;
        let cursor = connection
            .cursors
            .lock()
            .unwrap()
            .remove(&params.cursor)
            .ok_or_else(|| DriverError::invalid("The result was closed: run it again"))?;
        let rows = limits::page_rows(params.page_rows) as u32;
        let (result, next) = page(&connection.session, &cursor.query, cursor.paging, rows)
            .await
            .map_err(|error| DriverError::new(error.code, error.message))?;
        let (_, rows, _) = read(result)?;
        let cursor = next.map(|paging| {
            let mut cursors = connection.cursors.lock().unwrap();
            cursors.insert(
                params.cursor.clone(),
                Cursor {
                    query: cursor.query,
                    paging,
                },
            );
            params.cursor.clone()
        });
        Ok(Page { rows, cursor })
    }

    async fn close(&self, params: CursorParams) -> Result<()> {
        self.connection(&params.connection)?
            .cursors
            .lock()
            .unwrap()
            .remove(&params.cursor);
        Ok(())
    }
}
