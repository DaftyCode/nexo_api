//! How the application's requests and the drivers' answers and errors translate.
use crate::connections::ConnectionSettings;
use nexo_application::ports::SqlConnection;
use nexo_domain::{Error, Result};
use nexo_driver_sdk::{
    DriverError,
    protocol::{ConnectParams, TlsSettings},
};
use serde::Serialize;
use serde_json::Value;

/// A driver's error as the application answers it: `database.<code>` with its detail.
pub(super) fn database_error(error: DriverError) -> Error {
    let code = serde_json::to_value(error.code)
        .ok()
        .and_then(|code| code.as_str().map(String::from))
        .unwrap_or_else(|| "internal".into());
    Error::Database {
        code,
        message: error.message,
        detail: error.detail,
    }
}

pub(super) fn to_json(value: impl Serialize) -> Result<Value> {
    serde_json::to_value(value).map_err(|error| Error::Infrastructure(error.to_string()))
}

/// The settings of a connection as its driver reads them.
pub(super) fn connect_params(session: &str, connection: SqlConnection) -> Result<ConnectParams> {
    let mode =
        serde_json::from_value(Value::String(connection.tls.mode.clone())).map_err(|_| {
            Error::Validation(format!(
                "Unknown TLS mode {}: use disable, prefer, require or verify",
                connection.tls.mode
            ))
        })?;
    Ok(ConnectParams {
        connection: session.to_owned(),
        host: connection.host,
        port: connection.port,
        database: connection.database,
        user: connection.user,
        password: connection.password,
        tls: TlsSettings {
            mode,
            ca_pem: connection.tls.ca_pem,
            cert_pem: connection.tls.cert_pem,
            key_pem: connection.tls.key_pem,
        },
        options: connection.options,
        read_only: connection.read_only,
        connect_timeout_ms: connection
            .connect_timeout
            .map(|limit| limit.as_millis() as u64),
        proxy: None,
    })
}

/// What the host keeps with the connection, besides what its driver is told.
pub(super) fn settings(connection: &SqlConnection) -> ConnectionSettings {
    ConnectionSettings {
        secret_hosts: connection.secret_hosts.clone(),
        route: connection.route.clone(),
        idle: connection.idle,
        keep_alive: connection.keep_alive.clone(),
    }
}
