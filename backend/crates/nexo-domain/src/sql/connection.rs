//! A saved connection to a SQL database (or any engine of a module):
//! `{driver, host, port, database, user, password, params, tls, type, folder, color,
//! readOnly, autoCommit, timeoutSeconds, route}` and its session settings (`session.rs`). Its secrets are never stored: the password,
//! the client key and the password of its proxy are references to the vault (`{{vault:…}}`).
use crate::{Error, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// How careful Nexo is with a connection, as DBeaver's connection types.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ConnectionType {
    #[default]
    Development,
    Test,
    /// Writes need a confirmation, and transactions are manual by default.
    Production,
}
impl ConnectionType {
    pub fn of(connection: &Value) -> Self {
        serde_json::from_value(connection.get("type").cloned().unwrap_or(Value::Null))
            .unwrap_or_default()
    }
}

fn invalid(message: &str) -> Error {
    Error::Validation(message.into())
}

/// Whether `text` is one reference to the vault and nothing else.
fn is_vault_reference(text: &str) -> bool {
    let Some(inner) = text
        .trim()
        .strip_prefix("{{")
        .and_then(|rest| rest.strip_suffix("}}"))
    else {
        return false;
    };
    inner
        .trim()
        .strip_prefix("vault:")
        .is_some_and(|name| !name.trim().is_empty() && !name.contains(['{', '}']))
}

fn text<'a>(value: &'a Value, field: &str) -> Result<Option<&'a str>> {
    match value.get(field) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(text)) => Ok(Some(text.as_str()).filter(|text| !text.trim().is_empty())),
        Some(_) => Err(Error::Validation(format!(
            "The connection's {field} must be text"
        ))),
    }
}

/// A port of the connection or of its proxy: a number from 1 to 65535, none, or a variable of
/// the environment, replaced when it connects.
fn valid_port(port: Option<&Value>) -> bool {
    match port {
        None | Some(Value::Null) => true,
        Some(Value::Number(port)) => port
            .as_u64()
            .is_some_and(|port| (1..=65535).contains(&port)),
        Some(Value::String(port)) if port.contains("{{") || port.trim().is_empty() => true,
        Some(Value::String(port)) => port.trim().parse::<u16>().is_ok_and(|port| port > 0),
        Some(_) => false,
    }
}

/// How the connection reaches its server (DB-25): directly, through a SOCKS5 proxy (its
/// password in the vault) or an SSH tunnel of a profile. Database protocols do not go through
/// HTTP proxies.
fn validate_route(route: Option<&Value>) -> Result<()> {
    let Some(route) = route.filter(|route| !route.is_null()) else {
        return Ok(());
    };
    if !route.is_object() {
        return Err(invalid("The route of the connection is not valid"));
    }
    match text(route, "via")?.unwrap_or("direct") {
        "direct" => Ok(()),
        "ssh" if text(route, "profile")?.is_some() => Ok(()),
        "ssh" => Err(invalid("Choose the SSH profile to connect through")),
        "socks5" => {
            if text(route, "host")?.is_none() {
                return Err(invalid("Write the server of the SOCKS5 proxy"));
            }
            if !valid_port(route.get("port")) {
                return Err(invalid("The port of the proxy is a number from 1 to 65535"));
            }
            if text(route, "password")?.is_some_and(|secret| !is_vault_reference(secret)) {
                return Err(invalid(
                    "Keep the password of the proxy out of the connection: Nexo keeps it in the vault",
                ));
            }
            Ok(())
        }
        "http" => Err(invalid(
            "A database connection goes through a SOCKS5 proxy or an SSH tunnel, not an HTTP proxy",
        )),
        _ => Err(invalid("The route of the connection is not valid")),
    }
}

/// Checks a SQL connection before it is saved.
pub fn validate_connection(value: &Value) -> Result<()> {
    let driver =
        text(value, "driver")?.ok_or_else(|| invalid("Choose the database of the connection"))?;
    let valid_driver = driver.len() <= 32
        && driver
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-');
    if !valid_driver {
        return Err(invalid("Unknown database driver"));
    }
    for field in ["host", "database", "user", "folder", "color", "localClient"] {
        if text(value, field)?.is_some_and(|text| text.len() > 1024) {
            return Err(Error::Validation(format!(
                "The connection's {field} is too long"
            )));
        }
    }
    if text(value, "host")?.is_none() && text(value, "database")?.is_none() {
        return Err(invalid("A connection needs a server or a database"));
    }
    if !valid_port(value.get("port")) {
        return Err(invalid("The port is a number from 1 to 65535"));
    }
    let secrets = [
        ("password", text(value, "password")?),
        (
            "client key",
            value
                .get("tls")
                .map(|tls| text(tls, "keyPem"))
                .transpose()?
                .flatten(),
        ),
    ];
    for (name, secret) in secrets {
        if secret.is_some_and(|secret| !is_vault_reference(secret)) {
            return Err(Error::Validation(format!(
                "Keep the {name} out of the connection: Nexo keeps it in the vault"
            )));
        }
    }
    validate_route(value.get("route"))?;
    // The default schema, startup queries and the times its sessions keep (DB-25).
    super::SessionSettings::read(
        value,
        super::Dialect::parse(driver),
        value.get("readOnly") == Some(&Value::Bool(true)),
    )?;
    if let Some(kind) = value.get("type")
        && !kind.is_null()
        && serde_json::from_value::<ConnectionType>(kind.clone()).is_err()
    {
        return Err(invalid(
            "A connection is for development, test or production",
        ));
    }
    match value.get("params") {
        None | Some(Value::Null) => {}
        Some(Value::Object(params))
            if params.len() <= 64 && params.values().all(|value| value.is_string()) => {}
        Some(_) => return Err(invalid("The driver settings are up to 64 texts")),
    }
    match value.get("timeoutSeconds") {
        None | Some(Value::Null) => {}
        Some(Value::Number(seconds))
            if seconds.as_u64().is_some_and(|s| (1..=3600).contains(&s)) => {}
        Some(_) => {
            return Err(invalid(
                "The statement time limit is from 1 to 3600 seconds",
            ));
        }
    }
    Ok(())
}
