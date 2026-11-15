//! Opening a connection: the TCP stream through the host's egress policy (a named instance
//! first asks the SQL Server Browser for its port), TDS with the encryption chosen, and the
//! session that serves it.
use crate::{
    browser,
    errors::driver_error,
    session::{self, Command, Rows, Sql},
};
use nexo_driver_sdk::{
    DriverError, HostLink, Result, Value, net,
    protocol::{ConnectParams, ServerInfo, TlsMode},
    statements::{ExecuteParams, ExecuteResult, Page, TransactionAction, TransactionState},
};
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};
use tiberius::{AuthMethod, Config, EncryptionLevel};
use tokio::sync::{mpsc, oneshot};
use tokio_util::compat::TokioAsyncWriteCompatExt;

/// The settings the driver takes, besides the connection's fields.
pub(crate) const SETTINGS: [&str; 3] = ["application_name", "instance", "strict"];

pub(crate) struct MsConnection {
    commands: mpsc::Sender<Command>,
    cancel: mpsc::UnboundedSender<String>,
    closed: Arc<AtomicBool>,
    /// The database the connection opened on.
    pub database: String,
    /// The major version of the server (15 = 2019, 16 = 2022).
    pub major: u32,
}

pub(crate) fn not_open() -> DriverError {
    DriverError::invalid("The connection is not open")
}

fn configure(params: &ConnectParams, host: &str, port: u16) -> Result<Config> {
    if let Some(name) = params
        .options
        .keys()
        .find(|name| !SETTINGS.contains(&name.as_str()))
    {
        return Err(DriverError::invalid(format!(
            "SQL Server has no setting {name}: use {}",
            SETTINGS.join(", ")
        )));
    }
    if params.tls.cert_pem.is_some() {
        return Err(DriverError::invalid(
            "SQL Server logins do not use client certificates here",
        ));
    }
    let mut config = Config::new();
    config.host(host);
    config.port(port);
    if let Some(database) = params
        .database
        .as_deref()
        .filter(|name| !name.trim().is_empty())
    {
        config.database(database);
    }
    config.authentication(AuthMethod::sql_server(
        params.user.clone().unwrap_or_default(),
        params.password.clone().unwrap_or_default(),
    ));
    config.application_name(
        params
            .options
            .get("application_name")
            .map_or("Nexo", String::as_str),
    );
    // ApplicationIntent=ReadOnly: an availability group sends it to a readable secondary.
    config.readonly(params.read_only);
    let strict = params
        .options
        .get("strict")
        .is_some_and(|value| value == "true");
    config.encryption(match (params.tls.mode, strict) {
        (_, true) => EncryptionLevel::Strict,
        (TlsMode::Disable, _) => EncryptionLevel::Off,
        (TlsMode::Prefer, _) => EncryptionLevel::On,
        (TlsMode::Require | TlsMode::Verify, _) => EncryptionLevel::Required,
    });
    if params.tls.mode != TlsMode::Verify {
        // SQL Server encrypts at least the login, also without TLS for the rest: the
        // server's certificate is taken as it is unless it is checked (the form says so).
        config.trust_cert();
    } else if let Some(ca) = &params.tls.ca_pem {
        config.trust_cert_ca_bundle(ca.as_bytes().to_vec());
    }
    Ok(config)
}

/// Where to connect: `server\instance` or the `instance` setting asks the Browser.
async fn address(link: &HostLink, params: &ConnectParams) -> Result<(String, u16)> {
    let given = params.host.clone().unwrap_or_else(|| "localhost".into());
    let (host, instance) = match given.split_once('\\') {
        Some((host, instance)) => (host.to_owned(), Some(instance.to_owned())),
        None => (given, params.options.get("instance").cloned()),
    };
    match instance.filter(|name| !name.trim().is_empty()) {
        Some(instance) => {
            let port = browser::port(link, &params.connection, &host, &instance).await?;
            Ok((host, port))
        }
        None => Ok((host, params.port.unwrap_or(1433))),
    }
}

/// The options SSMS and the other clients set: without them, writing to a table with a
/// filtered index or a computed column fails (error 1934).
const ANSI: &str = "SET QUOTED_IDENTIFIER ON; SET ANSI_NULLS ON; SET ANSI_PADDING ON; SET ANSI_WARNINGS ON; \
                    SET CONCAT_NULL_YIELDS_NULL ON; SET ARITHABORT ON; SET NUMERIC_ROUNDABORT OFF";

/// Opens the TDS connection, the first time and again when the session has to.
pub(crate) struct Opener {
    link: HostLink,
    params: ConnectParams,
    host: String,
    port: u16,
}

impl Opener {
    /// A TDS connection with the ANSI options, on `database` or the connection's own.
    pub async fn open(&self, database: Option<&str>) -> Result<Sql> {
        let mut config = configure(&self.params, &self.host, self.port)?;
        if let Some(database) = database {
            config.database(database);
        }
        let tcp = net::connect(&self.link, &self.params.connection, &self.host, self.port).await?;
        let mut client = tiberius::Client::connect(config, tcp.compat_write())
            .await
            .map_err(|error| match driver_error(error) {
                error if error.message.contains("Cannot open database") => {
                    DriverError::invalid(error.message)
                }
                error => error,
            })?;
        session::batch(&mut client, ANSI).await?;
        Ok(client)
    }
}

impl MsConnection {
    pub async fn open(link: HostLink, params: ConnectParams) -> Result<(Self, ServerInfo)> {
        let (host, port) = address(&link, &params).await?;
        let tls = params.tls.mode != TlsMode::Disable || params.options.contains_key("strict");
        let opener = Opener {
            link,
            params,
            host,
            port,
        };
        let client = opener.open(None).await?;
        let (commands, receiver) = mpsc::channel(16);
        let (cancel, cancelled) = mpsc::unbounded_channel();
        let closed = Arc::new(AtomicBool::new(false));
        session::spawn(client, opener, receiver, cancelled, closed.clone());
        let mut connection = Self {
            commands,
            cancel,
            closed,
            database: String::new(),
            major: 0,
        };
        let about = connection
            .query(
                "SELECT CAST(SERVERPROPERTY('ProductVersion') AS nvarchar(64)), \
                 CAST(SERVERPROPERTY('Edition') AS nvarchar(128)), DB_NAME(), SUSER_SNAME()",
                Vec::new(),
            )
            .await?;
        let text = |index: usize| match about.rows.first().and_then(|row| row.get(index)) {
            Some(Value::Text(text)) => text.clone(),
            _ => String::new(),
        };
        connection.database = text(2);
        connection.major = text(0)
            .split('.')
            .next()
            .and_then(|major| major.parse().ok())
            .unwrap_or(0);
        let server = ServerInfo {
            server_version: text(0),
            product: Some(format!("Microsoft SQL Server {}", text(1))),
            database: Some(text(2)),
            user: Some(text(3)),
            tls,
        };
        Ok((connection, server))
    }

    pub fn closed(&self) -> bool {
        self.closed.load(Ordering::Relaxed)
    }

    async fn ask<T>(
        &self,
        command: impl FnOnce(oneshot::Sender<Result<T>>) -> Command,
    ) -> Result<T> {
        let (reply, answer) = oneshot::channel();
        self.commands.send(command(reply)).await.map_err(|_| {
            DriverError::closed("The connection to SQL Server closed: connect again")
        })?;
        answer.await.map_err(|_| {
            DriverError::closed("The connection to SQL Server closed: connect again")
        })?
    }

    /// Every row of the first result of a query, for the catalog.
    pub async fn query(&self, sql: &str, params: Vec<Value>) -> Result<Rows> {
        let sql = sql.to_owned();
        self.ask(|reply| Command::Query { sql, params, reply })
            .await
    }
    pub async fn execute(&self, params: ExecuteParams) -> Result<ExecuteResult> {
        self.ask(|reply| Command::Execute { params, reply }).await
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
    /// Asks the running statement `name` to stop: the session sends a TDS attention.
    pub fn cancel(&self, name: &str) {
        let _ = self.cancel.send(name.to_owned());
    }
}
