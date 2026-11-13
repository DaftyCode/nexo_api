//! A connection to PostgreSQL: opened through the host's egress policy (the driver never
//! resolves a name), with TLS on the SDK's settings, and with the server's notices kept for
//! the statement that caused them.
use crate::{errors::database, tls::RustlsConnect};
use nexo_driver_sdk::{
    DriverError, HostLink, Result, limits, net,
    protocol::{ConnectParams, TlsMode},
    statements::Notice,
    tls::client_config,
};
use rustls_pki_types::ServerName;
use std::sync::{Arc, Mutex};
use tokio::io::{AsyncRead, AsyncWrite};
use tokio_postgres::{
    AsyncMessage, CancelToken, Client, Config, Connection, NoTls,
    config::{ChannelBinding, SslMode},
    tls::TlsConnect,
};

/// Notices kept for one statement at most.
const NOTICES: usize = 1000;
/// The settings of a connection a PostgreSQL module accepts, besides its fields.
pub(crate) const SETTINGS: [&str; 3] = ["application_name", "options", "search_path"];

pub(crate) type Notices = Arc<Mutex<Vec<Notice>>>;

/// An open connection and what it needs besides its client.
pub(crate) struct Opened {
    pub client: Client,
    pub cancel: CancelToken,
    pub notices: Notices,
    pub tls: Option<RustlsConnect>,
}

/// Escapes a value of a `-c name=value` option, where spaces and backslashes are special.
fn option_value(value: &str) -> String {
    value.replace('\\', "\\\\").replace(' ', "\\ ")
}

fn config(params: &ConnectParams, database: Option<&str>) -> Result<Config> {
    let mut config = Config::new();
    config
        .user(params.user.as_deref().unwrap_or("postgres"))
        .application_name("Nexo")
        .channel_binding(ChannelBinding::Disable)
        .connect_timeout(limits::CONNECT);
    if let Some(password) = &params.password {
        config.password(password.as_bytes());
    }
    if let Some(database) = database.or(params.database.as_deref()) {
        config.dbname(database);
    }
    let mut options = Vec::new();
    for (name, value) in &params.options {
        match name.as_str() {
            "application_name" => {
                config.application_name(value);
            }
            "options" => options.push(value.clone()),
            "search_path" => options.push(format!("-c search_path={}", option_value(value))),
            other => {
                return Err(DriverError::invalid(format!(
                    "PostgreSQL has no setting {other}; use {}",
                    SETTINGS.join(", ")
                )));
            }
        }
    }
    // The server refuses writes in the session: the application refuses them before, too.
    if params.read_only {
        options.push("-c default_transaction_read_only=on".into());
    }
    if !options.is_empty() {
        config.options(options.join(" "));
    }
    config.ssl_mode(match params.tls.mode {
        TlsMode::Disable => SslMode::Disable,
        TlsMode::Prefer => SslMode::Prefer,
        TlsMode::Require | TlsMode::Verify => SslMode::Require,
    });
    Ok(config)
}

/// Reads the connection's messages until it ends, keeping the notices.
fn pump<S, T>(mut connection: Connection<S, T>, notices: Notices)
where
    S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
    T: AsyncRead + AsyncWrite + Unpin + Send + 'static,
{
    tokio::spawn(async move {
        while let Some(Ok(message)) =
            std::future::poll_fn(|context| connection.poll_message(context)).await
        {
            if let AsyncMessage::Notice(notice) = message {
                let severity = match notice.severity() {
                    "WARNING" => "warning",
                    "ERROR" | "FATAL" | "PANIC" => "error",
                    _ => "info",
                };
                let mut kept = notices.lock().unwrap();
                if kept.len() < NOTICES {
                    kept.push(Notice {
                        severity: severity.into(),
                        message: notice.message().into(),
                    });
                }
            }
        }
    });
}

async fn handshake<T>(
    config: &Config,
    stream: tokio::net::TcpStream,
    tls: T,
    notices: &Notices,
) -> std::result::Result<Client, tokio_postgres::Error>
where
    T: TlsConnect<tokio::net::TcpStream>,
    T::Stream: Send + 'static,
{
    let (client, connection) = config.connect_raw(stream, tls).await?;
    pump(connection, notices.clone());
    Ok(client)
}

/// Opens a connection to `database` (the connection's own when `None`).
pub(crate) async fn open(
    link: &HostLink,
    params: &ConnectParams,
    other: Option<&str>,
) -> Result<Opened> {
    let host = params
        .host
        .as_deref()
        .ok_or_else(|| DriverError::invalid("A PostgreSQL connection needs a server"))?;
    let config = config(params, other)?;
    let stream = net::connect(link, &params.connection, host, params.port.unwrap_or(5432)).await?;
    let tls = client_config(&params.tls)?
        .map(|config| -> Result<RustlsConnect> {
            let server = ServerName::try_from(host.to_owned())
                .map_err(|_| DriverError::tls(format!("{host} is not a server name")))?;
            Ok(RustlsConnect { config, server })
        })
        .transpose()?;
    let notices = Notices::default();
    let opening = async {
        match &tls {
            None => handshake(&config, stream, NoTls, &notices).await,
            Some(tls) => handshake(&config, stream, tls.clone(), &notices).await,
        }
    };
    let client = tokio::time::timeout(limits::CONNECT, opening)
        .await
        .map_err(|_| DriverError::timeout(format!("{host} did not answer in time")))?
        .map_err(|error| database(error, None))?;
    let cancel = client.cancel_token();
    Ok(Opened {
        client,
        cancel,
        notices,
        tls,
    })
}
