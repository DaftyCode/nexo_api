//! A connection to MySQL or MariaDB: opened at the addresses the host resolved (the driver
//! never resolves a name), with TLS on rustls and aws-lc-rs, the session settings the person
//! chose, and a session task that does what is asked, one thing at a time.
mod options;

use crate::{
    errors::database,
    session::{self, Command, Rows},
};
use mysql_async::{Conn, OptsBuilder, SslOpts, prelude::Queryable};
use nexo_driver_sdk::{
    DriverError, HostLink, Result, Value, limits,
    protocol::{ConnectParams, ServerInfo, TlsMode},
    statements::{ExecuteParams, ExecuteResult, Page, TransactionAction, TransactionState},
};
use options::{setup, text, tls};
use std::{
    collections::HashSet,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
};
use tokio::sync::{mpsc, oneshot};

/// The settings of a connection a MySQL module accepts, besides its fields.
pub(crate) const SETTINGS: [&str; 2] = ["charset", "time_zone"];
const PORT: u16 = 3306;

/// What the server is: catalogs differ between versions and between MySQL and MariaDB.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct Server {
    pub major: u16,
    pub minor: u16,
    pub mariadb: bool,
}
impl Server {
    pub fn at_least(&self, major: u16, minor: u16) -> bool {
        (self.major, self.minor) >= (major, minor)
    }
}

/// Opens connections like the first one: the session's, and the one that cancels.
#[derive(Clone)]
pub(crate) struct Opener {
    link: HostLink,
    params: ConnectParams,
}

impl Opener {
    pub fn new(link: HostLink, params: ConnectParams) -> Self {
        Self { link, params }
    }

    /// Opens a connection, with TLS when the mode asks; «prefer» falls back to plain text
    /// when the server has no TLS.
    pub async fn open(&self) -> Result<Conn> {
        let params = &self.params;
        let host = params
            .host
            .as_deref()
            .ok_or_else(|| DriverError::invalid("A MySQL connection needs a server"))?;
        let port = params.port.unwrap_or(PORT);
        let addresses = self.link.resolve(&params.connection, host, port).await?;
        if addresses.is_empty() {
            return Err(DriverError::network(format!("{host} has no address")));
        }
        let ips: Vec<_> = addresses.iter().map(|address| address.ip()).collect();
        let base = OptsBuilder::default()
            .ip_or_hostname(host)
            .tcp_port(port)
            .resolved_ips(Some(ips))
            .user(params.user.clone().or(Some("root".into())))
            .pass(params.password.clone())
            .db_name(text(&params.database).map(str::to_owned))
            .prefer_socket(false)
            .tcp_nodelay(true)
            // A write counts the rows it matched, as Connector/J and the other engines do.
            .client_found_rows(true)
            .stmt_cache_size(16)
            .setup(setup(params)?);
        let attempt = |options: Option<SslOpts>| {
            let opts = base.clone().ssl_opts(options);
            async move {
                tokio::time::timeout(limits::connect(), Conn::new(opts))
                    .await
                    .map_err(|_| DriverError::timeout(format!("{host} did not answer in time")))?
                    .map_err(|error| database(error, None))
            }
        };
        let secure = tls(params)?;
        match attempt(secure.clone()).await {
            Err(error)
                if params.tls.mode == TlsMode::Prefer
                    && error.message == "The server does not offer TLS" =>
            {
                attempt(None).await
            }
            other => other,
        }
    }
}

/// An open connection: its session, its id on the server, and the statements running.
pub(crate) struct MyConnection {
    commands: mpsc::Sender<Command>,
    closed: Arc<AtomicBool>,
    opener: Opener,
    /// The connection's id, to stop its statement from another connection.
    id: u32,
    pub server: Server,
    running: Mutex<HashSet<String>>,
    /// Statements asked to stop: they answer that they were cancelled.
    cancelled: Mutex<HashSet<String>>,
}

impl MyConnection {
    /// Opens a connection and reads what the server says about itself.
    pub async fn open(link: HostLink, params: ConnectParams) -> Result<(Self, ServerInfo)> {
        let opener = Opener::new(link, params);
        let mut conn = opener.open().await?;
        let failed = |error| database(error, None);
        let about: Option<(String, Option<String>, String)> = conn
            .query_first("SELECT VERSION(), DATABASE(), CURRENT_USER()")
            .await
            .map_err(failed)?;
        let (version, database, user) = about.unwrap_or_default();
        let cipher: Option<(String, String)> = conn
            .query_first("SHOW SESSION STATUS LIKE 'Ssl_cipher'")
            .await
            .map_err(failed)?;
        let (major, minor, _) = conn.server_version();
        let server = Server {
            major,
            minor,
            mariadb: version.to_ascii_lowercase().contains("mariadb"),
        };
        let info = ServerInfo {
            server_version: version.split('-').next().unwrap_or_default().to_owned(),
            product: Some(if server.mariadb { "MariaDB" } else { "MySQL" }.into()),
            database,
            user: Some(user),
            tls: cipher.is_some_and(|(_, value)| !value.is_empty()),
        };
        let id = conn.id();
        let (commands, receiver) = mpsc::channel(8);
        let closed = Arc::new(AtomicBool::new(false));
        session::spawn(conn, receiver, closed.clone());
        let connection = Self {
            commands,
            closed,
            opener,
            id,
            server,
            running: Mutex::default(),
            cancelled: Mutex::default(),
        };
        Ok((connection, info))
    }

    pub fn closed(&self) -> bool {
        self.closed.load(Ordering::Relaxed)
    }

    async fn ask<T>(
        &self,
        command: impl FnOnce(oneshot::Sender<Result<T>>) -> Command,
    ) -> Result<T> {
        let (reply, answer) = oneshot::channel();
        self.commands
            .send(command(reply))
            .await
            .map_err(|_| closed())?;
        answer.await.map_err(|_| closed())?
    }

    /// Every row of a catalog query, its values bound.
    pub async fn query(&self, sql: &str, params: Vec<Value>) -> Result<Rows> {
        let sql = sql.to_owned();
        self.ask(|reply| Command::Query { sql, params, reply })
            .await
    }

    pub async fn execute(&self, params: ExecuteParams) -> Result<ExecuteResult> {
        let name = params.statement.clone();
        self.running.lock().unwrap().insert(name.clone());
        let outcome = self.ask(|reply| Command::Execute { params, reply }).await;
        self.running.lock().unwrap().remove(&name);
        if self.cancelled.lock().unwrap().remove(&name) {
            return Err(DriverError::new(
                nexo_driver_sdk::ErrorCode::Cancelled,
                "The statement was cancelled",
            ));
        }
        outcome
    }

    pub async fn fetch(&self, cursor: String, rows: u64) -> Result<Page> {
        self.ask(|reply| Command::Fetch {
            cursor,
            rows,
            reply,
        })
        .await
    }

    pub async fn close(&self, cursor: String) -> Result<()> {
        self.ask(|reply| Command::Close { cursor, reply }).await
    }

    pub async fn transaction(
        &self,
        action: TransactionAction,
        isolation: Option<String>,
    ) -> Result<TransactionState> {
        self.ask(|reply| Command::Transaction {
            action,
            isolation,
            reply,
        })
        .await
    }

    /// Stops the statement if it is running, with `KILL QUERY` from another connection: the
    /// session's connection stays open and says the statement was interrupted.
    pub async fn cancel(&self, statement: &str) -> Result<()> {
        if !self.running.lock().unwrap().contains(statement) {
            return Ok(());
        }
        self.cancelled.lock().unwrap().insert(statement.to_owned());
        let mut other = self.opener.open().await?;
        let killed = other.query_drop(format!("KILL QUERY {}", self.id)).await;
        let _ = other.disconnect().await;
        killed.map_err(|error| database(error, None))
    }
}

fn closed() -> DriverError {
    DriverError::closed("The server closed the connection: connect again")
}

pub(crate) fn not_open() -> DriverError {
    DriverError::invalid("The connection is not open")
}
