//! The Apache Drill module (DB-37), through the REST API of a Drillbit (there is no Rust
//! client of its native protocol): only the Drillbits the connection names, each one
//! resolved by the host. The tree lists the storage plugins, their schemas, tables, views
//! and files, and their columns; a plugin's configuration is shown without its credentials.
//! The API does not page: each page runs the statement again with `LIMIT` and `OFFSET`, and
//! the answer says so. A running statement is cancelled through `/profiles`.
//!
//! The design of the drivers is in `docs/ARCHITECTURE.md`, section "Database modules".
mod catalog;
mod rest;
mod statements;
mod values;

use async_trait::async_trait;
use nexo_driver_sdk::{
    Column, Driver, DriverError, HostLink, PROTOCOL_VERSION, Result,
    explain::{ExplainMode, ExplainParams, Plan},
    limits,
    protocol::{
        Capabilities, ConnectParams, Ddl, Dialect, DriverInfo, Hello, ObjectDescription,
        ObjectParams, ServerInfo, TestReport, TreeNode,
    },
    statements::{
        CancelParams, CursorParams, ExecuteParams, ExecuteResult, FetchParams, Notice, Page,
    },
};
use rest::Drill;
use statements::{pageable, paged};
use std::{
    collections::HashMap,
    sync::{
        Arc, Mutex,
        atomic::{AtomicU64, Ordering},
    },
    time::Instant,
};

/// The settings a Drill connection accepts, besides the common ones: none.
pub const SETTINGS: [&str; 0] = [];

/// What a page after the first runs again: the statement, from where the last page stopped.
struct Cursor {
    sql: String,
    offset: u64,
    columns: Vec<Column>,
}

struct DrillConnection {
    drill: Drill,
    cursors: Mutex<HashMap<String, Cursor>>,
    /// The statements running, by the name the editor gave them, to cancel them.
    running: Mutex<HashMap<String, String>>,
}

#[derive(Default)]
pub struct DrillDriver {
    connections: Mutex<HashMap<String, Arc<DrillConnection>>>,
    cursors: AtomicU64,
}

fn not_open() -> DriverError {
    DriverError::invalid("The connection is not open")
}

impl DrillDriver {
    fn connection(&self, name: &str) -> Result<Arc<DrillConnection>> {
        self.connections
            .lock()
            .unwrap()
            .get(name)
            .cloned()
            .ok_or_else(not_open)
    }

    fn keep(&self, connection: &DrillConnection, cursor: Cursor) -> Result<String> {
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

async fn server(drill: &Drill, params: &ConnectParams) -> Result<ServerInfo> {
    let cluster = drill.send("GET", "/cluster.json", None).await?;
    let drillbits = cluster["drillbits"].as_array().map(Vec::len).unwrap_or(0);
    let version = cluster["drillbits"][0]["version"]
        .as_str()
        .or(cluster["currentVersion"].as_str())
        .unwrap_or_default();
    Ok(ServerInfo {
        server_version: version.to_owned(),
        product: Some(format!("Apache Drill ({drillbits} drillbits)")),
        database: drill.schema.clone(),
        user: params.user.clone().filter(|user| !user.is_empty()),
        tls: params.tls.mode != nexo_driver_sdk::protocol::TlsMode::Disable,
    })
}

#[async_trait]
impl Driver for DrillDriver {
    fn hello(&self) -> Hello {
        Hello {
            protocol: PROTOCOL_VERSION,
            driver: DriverInfo {
                id: "drill".into(),
                name: "Apache Drill".into(),
                version: env!("CARGO_PKG_VERSION").into(),
            },
            capabilities: Capabilities {
                schemas: true,
                cancel: true,
                explain: vec![ExplainMode::Estimated],
                ..Capabilities::default()
            },
            dialect: Dialect {
                name: "drill".into(),
                quote_open: "`".into(),
                quote_close: "`".into(),
                ..Dialect::default()
            },
        }
    }

    async fn connect(&self, host: &HostLink, params: ConnectParams) -> Result<ServerInfo> {
        if self.connections.lock().unwrap().len() >= limits::CONNECTIONS {
            return Err(DriverError::invalid("Too many Drill connections are open"));
        }
        let drill = Drill::open(host, &params).await?;
        let info = server(&drill, &params).await?;
        let connection = DrillConnection {
            drill,
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
        removed.map(|_| ()).ok_or_else(not_open)
    }

    async fn test(&self, host: &HostLink, params: ConnectParams) -> Result<TestReport> {
        let started = Instant::now();
        let drill = Drill::open(host, &params).await?;
        let info = server(&drill, &params).await?;
        Ok(TestReport {
            server: info,
            ping_ms: started.elapsed().as_millis() as u64,
        })
    }

    async fn tree(&self, params: ObjectParams) -> Result<Vec<TreeNode>> {
        catalog::tree(&self.connection(&params.connection)?.drill, &params.path).await
    }
    async fn describe(&self, params: ObjectParams) -> Result<ObjectDescription> {
        catalog::describe(&self.connection(&params.connection)?.drill, &params.path).await
    }
    async fn ddl(&self, params: ObjectParams) -> Result<Ddl> {
        catalog::ddl(&self.connection(&params.connection)?.drill, &params.path).await
    }

    async fn execute(&self, params: ExecuteParams) -> Result<ExecuteResult> {
        let connection = self.connection(&params.connection)?;
        if !params.params.is_empty() {
            return Err(DriverError::invalid(
                "Drill's REST API takes no parameters: write the values in the statement",
            ));
        }
        let started = Instant::now();
        let sql = params.sql.trim().trim_end_matches(';').to_owned();
        let rows = limits::page_rows(params.page_rows) as u64;
        connection
            .running
            .lock()
            .unwrap()
            .insert(params.statement.clone(), sql.clone());
        let answer = connection
            .drill
            .query(&sql, pageable(&sql).then_some(rows + 1))
            .await;
        connection.running.lock().unwrap().remove(&params.statement);
        let (columns, mut found) = values::rows(&answer?);
        let mut notices = Vec::new();
        let cursor = if pageable(&sql) && found.len() as u64 > rows {
            found.truncate(rows as usize);
            notices.push(Notice {
                severity: "info".into(),
                message: "Drill runs the query again for each page: its REST API does not page"
                    .into(),
            });
            Some(self.keep(
                &connection,
                Cursor {
                    sql,
                    offset: rows,
                    columns: columns.clone(),
                },
            )?)
        } else {
            None
        };
        Ok(ExecuteResult {
            columns,
            rows: found,
            cursor,
            notices,
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
            .ok_or_else(|| DriverError::invalid("The result was closed: run it again"))?;
        let rows = limits::page_rows(params.page_rows) as u64;
        let answer = connection
            .drill
            .query(&paged(&cursor.sql, rows, cursor.offset), None)
            .await?;
        // The columns of the first page decide how the values read.
        let mut found: Vec<Vec<_>> = answer["rows"]
            .as_array()
            .into_iter()
            .flatten()
            .map(|row| {
                cursor
                    .columns
                    .iter()
                    .map(|column| values::cell(&row[&column.name], column))
                    .collect()
            })
            .collect();
        let next = if found.len() as u64 > rows {
            found.truncate(rows as usize);
            let next = Cursor {
                sql: cursor.sql,
                offset: cursor.offset + rows,
                columns: cursor.columns,
            };
            Some(self.keep(&connection, next)?)
        } else {
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
        removed
            .map(|_| ())
            .ok_or_else(|| DriverError::invalid("The result was closed: run it again"))
    }

    /// Finds the statement among the queries running and cancels it.
    async fn cancel(&self, params: CancelParams) -> Result<()> {
        let connection = self.connection(&params.connection)?;
        let sql = connection
            .running
            .lock()
            .unwrap()
            .get(&params.statement)
            .cloned();
        match sql {
            Some(sql) => statements::cancel(&connection.drill, &sql).await,
            None => Ok(()),
        }
    }

    async fn explain(&self, params: ExplainParams) -> Result<Plan> {
        let connection = self.connection(&params.connection)?;
        statements::explain(&connection.drill, params.sql.trim().trim_end_matches(';')).await
    }
}
