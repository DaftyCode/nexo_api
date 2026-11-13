//! A saved connection to a SQL database (or any engine of a module):
//! `{driver, host, port, database, user, password, params, tls, type, folder, color,
//! readOnly, autoCommit, timeoutSeconds}`. Its secrets are never stored: the password and the
//! client key are references to the vault (`{{vault:…}}`).
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
    for field in ["host", "database", "user", "folder", "color"] {
        if text(value, field)?.is_some_and(|text| text.len() > 1024) {
            return Err(Error::Validation(format!(
                "The connection's {field} is too long"
            )));
        }
    }
    if text(value, "host")?.is_none() && text(value, "database")?.is_none() {
        return Err(invalid("A connection needs a server or a database"));
    }
    match value.get("port") {
        None | Some(Value::Null) => {}
        Some(Value::Number(port))
            if port
                .as_u64()
                .is_some_and(|port| (1..=65535).contains(&port)) => {}
        // A variable of the environment, replaced when it connects.
        Some(Value::String(port)) if port.contains("{{") || port.trim().is_empty() => {}
        Some(Value::String(port)) if port.trim().parse::<u16>().is_ok_and(|port| port > 0) => {}
        Some(_) => return Err(invalid("The port is a number from 1 to 65535")),
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
