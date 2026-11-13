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
}
