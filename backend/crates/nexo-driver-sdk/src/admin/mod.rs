//! Administering a server (`sessions`, `locks`, `kill`): the sessions open on it, who waits
//! for whom, and cancelling the statement of a session or ending the session.
//!
//! Every driver answers them with [`sessions`], [`locks`] and [`kill`] and its engine's
//! [`AdminCatalog`]: the catalog's queries run on the asking connection with the driver's
//! own `execute`, and their rows become the same shapes for every engine. The asking
//! connection is the driver's own session on the server, so it is marked and never ended.
mod run;
#[cfg(test)]
mod tests;

pub use run::{kill, locks, sessions};

use crate::{DriverError, Result, Value};
use serde::{Deserialize, Serialize};

/// Sessions and waits read at most, so a busy server does not flood the interface.
pub const MAX_ROWS: u32 = 2_000;

/// What a `kill` does: cancel the statement a session runs, or end the session.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum KillMode {
    Cancel,
    Terminate,
}

/// `sessions` and `locks`: read on the asking connection.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AdminParams {
    pub connection: String,
    /// The name of this run, to cancel it.
    pub statement: String,
}

/// `kill`: what to do to the session `session` of the server.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct KillParams {
    pub connection: String,
    pub statement: String,
    /// The session's id on the server, as [`ServerSession::id`] gives it.
    pub session: String,
    pub mode: KillMode,
}

/// A session of the server.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ServerSession {
    /// Its id on the server: a process id, a session id.
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub user: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub database: Option<String>,
    /// The program that opened it, as it said.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub application: Option<String>,
    /// Where it comes from: an address and a port, or a host name.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub client: Option<String>,
    /// Its state in the engine's words: `active`, `idle in transaction`, `Sleep`…
    #[serde(skip_serializing_if = "Option::is_none")]
    pub state: Option<String>,
    /// Seconds it has been in its state, or running its statement.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub seconds: Option<f64>,
    /// What it waits for, when it waits.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub wait: Option<String>,
    /// The statement it runs, or the last one it ran.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sql: Option<String>,
    /// It is running something (not idle).
    pub active: bool,
    /// It is the session that asked: the driver's own.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub own: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SessionList {
    pub sessions: Vec<ServerSession>,
    /// The privilege the user lacks to see every session: only some, or none, are listed.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub privilege: Option<String>,
}

/// A session that waits for a lock another one holds.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct LockWait {
    pub waiting: String,
    pub blocking: String,
    /// What is locked: a table, a row, a resource of the engine.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub object: Option<String>,
    /// The kind of lock asked for.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mode: Option<String>,
    /// Seconds it has waited.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub seconds: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub waiting_user: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub waiting_sql: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub blocking_user: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub blocking_sql: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct LockList {
    pub waits: Vec<LockWait>,
    /// The privilege the user lacks to see the locks of every session.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub privilege: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Killed {
    /// The server did it; `false` when there was no such session left.
    pub done: bool,
}

/// A statement of the catalog, with its values bound.
#[derive(Debug, Clone, PartialEq)]
pub struct AdminQuery {
    pub sql: String,
    pub params: Vec<Value>,
}

/// How one engine administers sessions: the queries of its catalog and the statements that
/// cancel and end one.
pub trait AdminCatalog: Send + Sync {
    /// Rows of id, user, database, application, client, state, seconds, wait, statement,
    /// whether it is the asking session's, and whether it is active.
    fn sessions(&self) -> String;
    /// Rows of the waiting session, the blocking one, the object, the mode, the seconds
    /// waited, and the user and statement of each side.
    fn locks(&self) -> String;
    /// One row: the privilege the user lacks to see every session and lock, or `NULL`.
    fn privilege(&self) -> String;
    /// One row: the id of the asking session.
    fn own(&self) -> String;
    /// The statement that does `mode` to the session `id`; a mode the engine has not is
    /// refused.
    fn kill(&self, id: &str, mode: KillMode) -> Result<AdminQuery>;
}

/// A session id that is a whole number, as PostgreSQL, MySQL and SQL Server name them. A
/// statement such as `KILL` takes no bound value, so it gets this number, never the text.
pub fn numeric_id(id: &str) -> Result<i64> {
    id.trim()
        .parse::<i64>()
        .ok()
        .filter(|number| *number > 0)
        .ok_or_else(|| DriverError::invalid(format!("{id} is not the id of a session")))
}
