//! Messages about the driver itself, its connections and the objects of a database. The
//! ones about statements are in [`crate::statements`].
use crate::Value;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

/// What a driver says about itself when it starts.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Hello {
    /// [`crate::PROTOCOL_VERSION`].
    pub protocol: u32,
    pub driver: DriverInfo,
    pub capabilities: Capabilities,
    pub dialect: Dialect,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DriverInfo {
    /// The module: `postgres`, `mysql`…
    pub id: String,
    pub name: String,
    pub version: String,
}

/// What the interface may offer for a connection of this driver.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Capabilities {
    pub transactions: bool,
    /// Databases hold schemas (PostgreSQL, SQL Server), not only tables.
    pub schemas: bool,
    /// A running statement can be cancelled.
    pub cancel: bool,
    /// A session can be opened so that the server refuses writes.
    pub read_only_sessions: bool,
    /// Optional methods the driver answers, beyond the ones every driver has.
    pub methods: Vec<String>,
    /// Groups of methods for engines that are not relational (`keyvalue`, `rest`,
    /// `document`).
    pub extensions: Vec<String>,
}

/// How the engine writes SQL, for the editor and for whatever builds statements.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Dialect {
    /// `postgresql`, `mysql`, `tsql`…
    pub name: String,
    /// What opens and closes a quoted identifier: `"` and `"`, `[` and `]`.
    pub quote_open: String,
    pub quote_close: String,
    /// How a bound parameter is written.
    pub parameters: ParameterStyle,
    pub keywords: Vec<String>,
    pub functions: Vec<String>,
    pub types: Vec<String>,
}
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ParameterStyle {
    /// `$1`, `$2`.
    Numbered,
    /// `?`.
    #[default]
    Question,
    /// `@p1` or `:name`.
    Named,
}

/// How a connection uses TLS.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum TlsMode {
    #[default]
    Disable,
    /// TLS when the server offers it.
    Prefer,
    /// TLS always, without checking the certificate.
    Require,
    /// TLS always, checking the certificate and the server name.
    Verify,
}
#[derive(Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default, deny_unknown_fields)]
pub struct TlsSettings {
    pub mode: TlsMode,
    /// Certificate authorities trusted besides the system's, in PEM.
    pub ca_pem: Option<String>,
    /// The client certificate and its key, in PEM.
    pub cert_pem: Option<String>,
    pub key_pem: Option<String>,
}

/// A connection to open. It is the only message that carries secrets.
#[derive(Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default, deny_unknown_fields)]
pub struct ConnectParams {
    /// The name the host gives this connection; every later message repeats it.
    pub connection: String,
    pub host: Option<String>,
    pub port: Option<u16>,
    pub database: Option<String>,
    pub user: Option<String>,
    pub password: Option<String>,
    pub tls: TlsSettings,
    /// Settings of the engine, from the closed list its driver accepts.
    pub options: BTreeMap<String, String>,
    /// The server should refuse writes in this session, where it can.
    pub read_only: bool,
}
impl std::fmt::Debug for ConnectParams {
    /// Never shows the password or the key, should a connection end up in a log.
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("ConnectParams")
            .field("connection", &self.connection)
            .field("host", &self.host)
            .field("port", &self.port)
            .field("database", &self.database)
            .field("user", &self.user)
            .field("tls", &self.tls.mode)
            .finish_non_exhaustive()
    }
}

/// What a server says once connected.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ServerInfo {
    pub server_version: String,
    /// A compatible server that is not the engine itself (CockroachDB, MariaDB…).
    pub product: Option<String>,
    pub database: Option<String>,
    pub user: Option<String>,
    pub tls: bool,
}
/// What "Test connection" found.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct TestReport {
    pub server: ServerInfo,
    /// Round trip of a trivial statement, in milliseconds.
    pub ping_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConnectionParams {
    pub connection: String,
}

/// An object of the tree, named by the segments from the connection down to it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ObjectParams {
    pub connection: String,
    #[serde(default)]
    pub path: Vec<String>,
}

/// A node of the tree. The driver decides the shape of the tree; the interface draws it.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct TreeNode {
    /// `database`, `schema`, `table`, `view`, `column`, `index`, `folder`…
    pub kind: String,
    /// The segment this node adds to its parent's path.
    pub name: String,
    pub label: String,
    /// What is shown beside the label: the type of a column, the rows of a table.
    pub detail: Option<String>,
    pub has_children: bool,
    /// What can be done with it: `open`, `data`, `ddl`, `drop`…
    pub actions: Vec<String>,
    /// An object of the engine itself or an administration folder: the simple view of the
    /// navigator hides it, as DBeaver's does.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub system: bool,
}
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct TreeNodes {
    pub nodes: Vec<TreeNode>,
}

/// What an object is like, in a shape the interface draws without knowing the engine.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ObjectDescription {
    pub kind: String,
    pub name: String,
    pub properties: Vec<Property>,
    /// Lists of the object: its columns, constraints, indexes…
    pub sections: Vec<Section>,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Property {
    pub name: String,
    pub value: Value,
}
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Section {
    pub id: String,
    pub title: String,
    pub columns: Vec<String>,
    pub rows: Vec<Vec<Value>>,
}
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Ddl {
    pub sql: String,
}

/// The driver asks which addresses of a host it may connect to.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NetResolveParams {
    pub connection: String,
    pub host: String,
    pub port: u16,
}
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct NetResolved {
    /// `ip:port`, each one already allowed by the egress policy.
    pub addresses: Vec<String>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LogParams {
    /// `debug`, `info`, `warn` or `error`.
    pub level: String,
    pub message: String,
}
