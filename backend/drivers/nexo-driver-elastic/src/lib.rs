//! The Elasticsearch and OpenSearch module (DB-36), through their HTTP API spoken by the
//! driver itself: only the nodes the connection names (no sniffing), each one resolved by
//! the host. Its tree lists indices with their fields, data streams, aliases, templates and
//! nodes; SQL runs through the engine's SQL API; and the `rest` extension sends a request of
//! the API to a path of the node, never to another host.
//!
//! The design of the drivers is in `docs/ARCHITECTURE.md`, section "Database modules".
mod api;
mod catalog;
mod error;
mod http;
mod sql;

use api::server;
use async_trait::async_trait;
use http::Client;
use nexo_driver_sdk::{
    Column, Driver, DriverError, HostLink, PROTOCOL_VERSION, Result,
    explain::{ExplainMode, ExplainParams, Plan},
    limits,
    protocol::{
        Capabilities, ConnectParams, Ddl, Dialect, DriverInfo, Hello, ObjectDescription,
        ObjectParams, ParameterStyle, ServerInfo, TestReport, TreeNode,
    },
    rest::{self, RestRequest},
    statements::{CursorParams, ExecuteParams, ExecuteResult, FetchParams, Page},
};
use serde_json::Value as Json;
use std::{
    collections::HashMap,
    sync::{
        Arc, Mutex,
        atomic::{AtomicU64, Ordering},
    },
    time::Instant,
};

/// The settings an Elasticsearch connection accepts, besides the common ones.
pub const SETTINGS: [&str; 1] = ["auth"];

/// Which engine answers: their SQL APIs differ.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Flavour {
    Elasticsearch,
    OpenSearch,
}

struct Cursor {
    server: String,
    columns: Vec<Column>,
}

struct ElasticConnection {
    client: Client,
    flavour: Flavour,
    cursors: Mutex<HashMap<String, Cursor>>,
}

#[derive(Default)]
pub struct ElasticDriver {
    connections: Mutex<HashMap<String, Arc<ElasticConnection>>>,
    cursors: AtomicU64,
}

fn not_open() -> DriverError {
    DriverError::invalid("The connection is not open")
}

impl ElasticDriver {
    fn connection(&self, name: &str) -> Result<Arc<ElasticConnection>> {
        self.connections
            .lock()
            .unwrap()
            .get(name)
            .cloned()
            .ok_or_else(not_open)
    }

    fn keep(
        &self,
        connection: &ElasticConnection,
        server: Option<String>,
        columns: &[Column],
    ) -> Result<Option<String>> {
        let Some(server) = server else {
            return Ok(None);
        };
        let mut cursors = connection.cursors.lock().unwrap();
        if cursors.len() >= limits::CURSORS {
            return Err(DriverError::invalid(
                "Too many results are still open: close some",
            ));
        }
        let id = format!("c{}", self.cursors.fetch_add(1, Ordering::Relaxed) + 1);
        cursors.insert(
            id.clone(),
            Cursor {
                server,
                columns: columns.to_vec(),
            },
        );
        Ok(Some(id))
    }
}

#[async_trait]
impl Driver for ElasticDriver {
    fn hello(&self) -> Hello {
        Hello {
            protocol: PROTOCOL_VERSION,
            driver: DriverInfo {
                id: "elastic".into(),
                name: "Elasticsearch and OpenSearch".into(),
                version: env!("CARGO_PKG_VERSION").into(),
            },
            capabilities: Capabilities {
                explain: vec![ExplainMode::Estimated],
                extensions: vec![rest::EXTENSION.into()],
                ..Capabilities::default()
            },
            dialect: Dialect {
                name: "elasticsearch".into(),
                quote_open: "\"".into(),
                quote_close: "\"".into(),
                parameters: ParameterStyle::Question,
                ..Dialect::default()
            },
        }
    }

    async fn connect(&self, host: &HostLink, params: ConnectParams) -> Result<ServerInfo> {
        if self.connections.lock().unwrap().len() >= limits::CONNECTIONS {
            return Err(DriverError::invalid(
                "Too many Elasticsearch connections are open",
            ));
        }
        let client = Client::new(host, &params)?;
        let (info, flavour) = server(&client, &params).await?;
        let connection = ElasticConnection {
            client,
            flavour,
            cursors: Mutex::new(HashMap::new()),
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
        let client = Client::new(host, &params)?;
        let started = Instant::now();
        let (info, _) = server(&client, &params).await?;
        let ping_ms = started.elapsed().as_millis() as u64;
        let health = catalog::get(&client, "/_cluster/health").await?;
        host.log(
            "info",
            format!(
                "Cluster {}: {}, {} nodes, {} shards not assigned",
                health["cluster_name"].as_str().unwrap_or_default(),
                health["status"].as_str().unwrap_or_default(),
                health["number_of_nodes"],
                health["unassigned_shards"]
            ),
        )
        .await;
        Ok(TestReport {
            server: info,
            ping_ms,
        })
    }

    async fn tree(&self, params: ObjectParams) -> Result<Vec<TreeNode>> {
        catalog::tree(&self.connection(&params.connection)?.client, &params.path).await
    }
    async fn describe(&self, params: ObjectParams) -> Result<ObjectDescription> {
        catalog::describe(&self.connection(&params.connection)?.client, &params.path).await
    }
    async fn ddl(&self, params: ObjectParams) -> Result<Ddl> {
        catalog::ddl(&self.connection(&params.connection)?.client, &params.path).await
    }

    async fn execute(&self, params: ExecuteParams) -> Result<ExecuteResult> {
        let connection = self.connection(&params.connection)?;
        let started = Instant::now();
        let rows = limits::page_rows(params.page_rows) as u32;
        let sql = params.sql.trim().trim_end_matches(';');
        let page = sql::query(
            &connection.client,
            connection.flavour,
            sql,
            &params.params,
            rows,
        )
        .await?;
        let cursor = self.keep(&connection, page.cursor, &page.columns)?;
        Ok(ExecuteResult {
            columns: page.columns,
            rows: page.rows,
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
            .ok_or_else(|| DriverError::invalid("The result was closed: run it again"))?;
        let page = sql::next(
            &connection.client,
            connection.flavour,
            &cursor.server,
            &cursor.columns,
        )
        .await?;
        let next = self.keep(&connection, page.cursor, &cursor.columns)?;
        Ok(Page {
            rows: page.rows,
            cursor: next,
        })
    }

    async fn close(&self, params: CursorParams) -> Result<()> {
        let connection = self.connection(&params.connection)?;
        let cursor = connection.cursors.lock().unwrap().remove(&params.cursor);
        match cursor {
            Some(cursor) => {
                sql::close(&connection.client, connection.flavour, &cursor.server).await
            }
            None => Err(DriverError::invalid("The result was closed: run it again")),
        }
    }

    async fn explain(&self, params: ExplainParams) -> Result<Plan> {
        let connection = self.connection(&params.connection)?;
        sql::translate(
            &connection.client,
            connection.flavour,
            params.sql.trim().trim_end_matches(';'),
        )
        .await
    }

    async fn extension(&self, _host: &HostLink, method: &str, params: Json) -> Result<Json> {
        if method != rest::methods::REQUEST {
            return Err(DriverError::invalid(format!("Unknown method {method}")));
        }
        let request: RestRequest = serde_json::from_value(params)
            .map_err(|error| DriverError::invalid(format!("Invalid request: {error}")))?;
        serde_json::to_value(self.request(request).await?)
            .map_err(|error| DriverError::internal(error.to_string()))
    }
}
