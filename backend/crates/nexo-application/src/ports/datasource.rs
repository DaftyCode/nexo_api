//! The databases of the modules (SQL and the engines that are not): sessions opened on the
//! driver of a module. Results come as the driver answers them, already in the shape the
//! interface reads; the application only checks what is asked and what may run.
use async_trait::async_trait;
use nexo_domain::{Result, hosts::AllowedHosts};
use serde_json::Value;
use std::{collections::BTreeMap, time::Duration};

/// How a connection uses TLS: `disable`, `prefer`, `require` or `verify`.
#[derive(Clone, Default, PartialEq, Eq)]
pub struct SqlTls {
    pub mode: String,
    pub ca_pem: Option<String>,
    pub cert_pem: Option<String>,
    pub key_pem: Option<String>,
}

/// A connection as a driver receives it: environment variables replaced and vault
/// references resolved.
#[derive(Clone, Default)]
pub struct SqlConnection {
    /// The module whose driver opens it.
    pub driver: String,
    pub host: Option<String>,
    pub port: Option<u16>,
    pub database: Option<String>,
    pub user: Option<String>,
    pub password: Option<String>,
    pub tls: SqlTls,
    /// Settings of the driver, from the closed list it accepts.
    pub options: BTreeMap<String, String>,
    /// The server should refuse writes in the session, where it can.
    pub read_only: bool,
    /// Vault secrets of the connection that may only reach some hosts, by name.
    pub secret_hosts: Vec<(String, AllowedHosts)>,
    /// How it reaches its server: directly, or through a SOCKS5 proxy or an SSH tunnel that
    /// the host opens for the driver (DB-25).
    pub route: super::ConnectionRoute,
    /// How long it may take to open, when not the drivers' own time.
    pub connect_timeout: Option<Duration>,
    /// How long it stays open unused, when shorter than the host's.
    pub idle: Option<Duration>,
    /// A trivial query run every so often while it is not used, to keep it alive.
    pub keep_alive: Option<(Duration, String)>,
}
impl std::fmt::Debug for SqlConnection {
    /// Never shows the password or the key, should a connection end up in a log.
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("SqlConnection")
            .field("driver", &self.driver)
            .field("host", &self.host)
            .field("port", &self.port)
            .field("database", &self.database)
            .field("user", &self.user)
            .field("read_only", &self.read_only)
            .field("route", &self.route)
            .finish_non_exhaustive()
    }
}

/// One statement to run in a session. Values are always bound, never written into it.
#[derive(Debug, Clone, Default)]
pub struct StatementRequest {
    /// The name the client gives this run, to cancel it.
    pub statement: String,
    pub sql: String,
    pub params: Vec<Value>,
    pub page_rows: Option<u32>,
    pub max_rows: Option<u64>,
    /// How long it may run; the driver's own limit when `None`.
    pub timeout: Option<Duration>,
}

#[async_trait]
pub trait DataSources: Send + Sync {
    /// What the driver of a module says about itself: its capabilities and dialect.
    async fn driver(&self, driver: &str) -> Result<Value>;
    /// Opens a connection, measures it and closes it.
    async fn test(&self, connection: SqlConnection) -> Result<Value>;
    /// Reaches the server of a connection through its route (SOCKS5 proxy or SSH tunnel)
    /// without opening a session: `{host, port, via, ms}`.
    async fn reach(&self, _connection: SqlConnection) -> Result<Value> {
        Err(nexo_domain::Error::Unavailable(
            "Database connections are not available here".into(),
        ))
    }
    /// Opens a session named `session`; answers what the server said about itself.
    async fn connect(&self, session: &str, connection: SqlConnection) -> Result<Value>;
    async fn disconnect(&self, session: &str) -> Result<()>;
    /// The children of a node of the tree; an empty path asks for the top ones.
    async fn tree(&self, session: &str, path: Vec<String>) -> Result<Value>;
    async fn describe(&self, session: &str, path: Vec<String>) -> Result<Value>;
    async fn ddl(&self, session: &str, path: Vec<String>) -> Result<Value>;
    /// Runs a statement: its first page, and a cursor when there are more rows.
    async fn execute(&self, session: &str, request: StatementRequest) -> Result<Value>;
    async fn fetch(&self, session: &str, cursor: &str, page_rows: Option<u32>) -> Result<Value>;
    async fn close(&self, session: &str, cursor: &str) -> Result<()>;
    async fn cancel(&self, session: &str, statement: &str) -> Result<()>;
    /// `status`, `begin`, `commit`, `rollback`, `auto` or `manual`.
    async fn transaction(
        &self,
        session: &str,
        action: &str,
        isolation: Option<String>,
    ) -> Result<Value>;
    /// Writes rows changed in the data grid as one: `request` names the table and the
    /// changes; the driver builds and runs the statements.
    async fn write_rows(&self, session: &str, request: Value) -> Result<Value>;
    /// The model of a table and the types of its engine (`nexo_driver_sdk::ddl`).
    async fn ddl_model(&self, session: &str, request: Value) -> Result<Value>;
    /// The statements that change a table into another; nothing runs.
    async fn ddl_plan(&self, session: &str, request: Value) -> Result<Value>;
    /// Objects or data found (`nexo_driver_sdk::search`).
    async fn search(&self, session: &str, request: Value) -> Result<Value>;
    /// A batch of rows written into a table (`nexo_driver_sdk::import`).
    async fn import(&self, session: &str, request: Value) -> Result<Value>;
    /// The plan of a statement: `{connection, statement, sql, params, mode, writes}`.
    async fn explain(&self, session: &str, request: Value) -> Result<Value>;
    /// The sessions open on the server (`nexo_driver_sdk::admin`): `{connection, statement}`.
    async fn sessions(&self, session: &str, request: Value) -> Result<Value>;
    /// Who waits for a lock another session holds: `{connection, statement}`.
    async fn locks(&self, session: &str, request: Value) -> Result<Value>;
    /// Cancels the statement of a session of the server, or ends it:
    /// `{connection, statement, session, mode}`.
    async fn kill(&self, session: &str, request: Value) -> Result<Value>;
    /// The panels of the server's dashboard its driver offers: `{connection}`.
    async fn dashboards(&self, session: &str, request: Value) -> Result<Value>;
    /// Keeps a session with an open transaction from being closed for being idle: the
    /// transaction would be lost with it.
    async fn hold(&self, _session: &str, _held: bool) -> Result<()> {
        Ok(())
    }
}
