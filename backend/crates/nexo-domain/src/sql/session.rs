//! What a SQL connection does as it opens and while it stays open (DB-25): its default schema
//! and startup queries, run in every session it opens; a trivial query that keeps it alive;
//! how long it stays open unused, and how long it may take to open. Stored in the connection
//! as `defaultSchema`, `startupQueries`, `ignoreStartupErrors`, `keepAliveSeconds`,
//! `idleMinutes` and `connectTimeoutSeconds`.
use super::{Dialect, StatementKind, classify, quote, split};
use crate::{Error, Result};
use serde_json::Value;
use std::{ops::RangeInclusive, time::Duration};

/// Startup queries of a connection, at most, and the length of each.
pub const STARTUP_QUERIES: usize = 20;
pub const STARTUP_QUERY_BYTES: usize = 8 * 1024;
/// A keep-alive query every so many seconds: under the ten minutes a connection may stay
/// unused (DB-00), when it would be closed anyway.
pub const KEEP_ALIVE_SECONDS: RangeInclusive<u64> = 5..=600;
/// Minutes a connection may stay unused before it is closed: at most DB-00's ten.
pub const IDLE_MINUTES: RangeInclusive<u64> = 1..=10;
/// Seconds a connection may take to open.
pub const CONNECT_SECONDS: RangeInclusive<u64> = 1..=120;

/// The settings of a connection's sessions, read from its stored value.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SessionSettings {
    pub default_schema: Option<String>,
    pub startup: Vec<String>,
    /// A startup query that fails is said, and the session still opens.
    pub ignore_startup_errors: bool,
    pub keep_alive: Option<Duration>,
    pub idle: Option<Duration>,
    pub connect_timeout: Option<Duration>,
}

fn invalid(message: impl Into<String>) -> Error {
    Error::Validation(message.into())
}

/// A whole number of a connection field within `range`, or none.
fn seconds(
    value: &Value,
    field: &str,
    range: RangeInclusive<u64>,
    what: &str,
) -> Result<Option<u64>> {
    match value.get(field) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::Number(number)) if number.as_u64().is_some_and(|n| range.contains(&n)) => {
            Ok(number.as_u64())
        }
        Some(_) => Err(invalid(format!(
            "{what} is from {} to {}",
            range.start(),
            range.end()
        ))),
    }
}

impl SessionSettings {
    /// Reads and checks the settings of a connection whose server speaks `dialect`. On a
    /// read-only connection a startup query may only read or set the session.
    pub fn read(value: &Value, dialect: Dialect, read_only: bool) -> Result<Self> {
        let default_schema = match value.get("defaultSchema") {
            None | Some(Value::Null) => None,
            Some(Value::String(text)) if text.trim().len() <= 512 => {
                Some(text.trim().to_string()).filter(|text| !text.is_empty())
            }
            Some(_) => return Err(invalid("The default schema is a name of up to 512 letters")),
        };
        let startup = match value.get("startupQueries") {
            None | Some(Value::Null) => Vec::new(),
            Some(Value::Array(items)) if items.len() <= STARTUP_QUERIES => items
                .iter()
                .map(|item| match item {
                    Value::String(text) if text.len() <= STARTUP_QUERY_BYTES => {
                        Ok(text.trim().to_string())
                    }
                    _ => Err(invalid(format!(
                        "Each startup query is a text of up to {} KB",
                        STARTUP_QUERY_BYTES / 1024
                    ))),
                })
                .filter(|query| query.as_ref().map_or(true, |text| !text.is_empty()))
                .collect::<Result<_>>()?,
            Some(_) => {
                return Err(invalid(format!(
                    "A connection has up to {STARTUP_QUERIES} startup queries"
                )));
            }
        };
        for query in &startup {
            check_startup(query, dialect, read_only)?;
        }
        let keep_alive = seconds(value, "keepAliveSeconds", KEEP_ALIVE_SECONDS, "Keep alive")?;
        let idle = seconds(value, "idleMinutes", IDLE_MINUTES, "Closing when unused")?;
        let connect = seconds(
            value,
            "connectTimeoutSeconds",
            CONNECT_SECONDS,
            "The time to connect",
        )?;
        Ok(Self {
            default_schema,
            startup,
            ignore_startup_errors: value.get("ignoreStartupErrors") == Some(&Value::Bool(true)),
            keep_alive: keep_alive.map(Duration::from_secs),
            idle: idle.map(|minutes| Duration::from_secs(minutes * 60)),
            connect_timeout: connect.map(Duration::from_secs),
        })
    }

    /// What a session runs as it opens: the default schema's statement, where its engine has
    /// one, and then the startup queries.
    pub fn opening(&self, dialect: Dialect) -> Vec<String> {
        let schema = self
            .default_schema
            .as_deref()
            .and_then(|schema| schema_statement(schema, dialect));
        schema
            .into_iter()
            .chain(self.startup.iter().cloned())
            .collect()
    }
}

/// A startup query is one statement; on a read-only connection it reads or sets the session.
fn check_startup(query: &str, dialect: Dialect, read_only: bool) -> Result<()> {
    if split(query, dialect).len() > 1 {
        return Err(invalid(format!(
            "Write one statement in each startup query: {query}"
        )));
    }
    let kind = classify(query, dialect).kind;
    if read_only && !matches!(kind, StatementKind::Read | StatementKind::Session) {
        return Err(invalid(format!(
            "A read-only connection only reads or sets the session as it opens: {query}"
        )));
    }
    Ok(())
}

/// The statement that makes `schema` (or several, separated by commas) the session's
/// default: PostgreSQL's `search_path`. MySQL's schema is its database, SQL Server's belongs
/// to the user and SQLite has none.
pub fn schema_statement(schema: &str, dialect: Dialect) -> Option<String> {
    if dialect != Dialect::PostgreSql {
        return None;
    }
    let names: Vec<String> = schema
        .split(',')
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .map(|name| quote(name, dialect))
        .collect();
    (!names.is_empty()).then(|| format!("SET search_path TO {}", names.join(", ")))
}

/// The trivial query that keeps a connection alive.
pub fn keep_alive_query(dialect: Dialect) -> &'static str {
    match dialect {
        Dialect::PlSql => "SELECT 1 FROM DUAL",
        _ => "SELECT 1",
    }
}
