//! A connection: a thread of its own owns the SQLite connection, whose calls block, and does
//! what is asked one thing at a time; the driver talks to it through a channel. Cancelling
//! goes around the channel, with SQLite's interrupt.
use crate::{
    errors, file,
    guard::Guard,
    session::{self, Command, Rows},
};
use nexo_driver_sdk::{
    DriverError, Result, Value, limits,
    protocol::{ConnectParams, ServerInfo},
    statements::{ExecuteParams, ExecuteResult, Page, TransactionAction, TransactionState},
};
use rusqlite::{Connection, InterruptHandle};
use std::{
    collections::BTreeMap,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};
use tokio::sync::{mpsc, oneshot};

/// The settings a connection takes: whether to create its file, and three pragmas.
pub(crate) const SETTINGS: [&str; 4] = ["create", "foreign_keys", "journal_mode", "busy_timeout"];
const JOURNAL_MODES: [&str; 6] = ["delete", "truncate", "persist", "memory", "wal", "off"];

struct Settings {
    create: bool,
    foreign_keys: bool,
    journal_mode: Option<String>,
    busy_timeout: u64,
}

fn flag(name: &str, value: &str) -> Result<bool> {
    match value.trim().to_ascii_lowercase().as_str() {
        "true" | "1" | "on" | "yes" => Ok(true),
        "false" | "0" | "off" | "no" => Ok(false),
        _ => Err(DriverError::invalid(format!(
            "{name} is true or false, not {value}"
        ))),
    }
}

fn settings(options: &BTreeMap<String, String>, read_only: bool) -> Result<Settings> {
    let mut found = Settings {
        create: false,
        // As DB Browser for SQLite does: the keys a file declares are kept.
        foreign_keys: true,
        journal_mode: None,
        busy_timeout: 5_000,
    };
    for (name, value) in options {
        match name.as_str() {
            "create" => found.create = flag(name, value)?,
            "foreign_keys" => found.foreign_keys = flag(name, value)?,
            "journal_mode" => {
                let mode = value.trim().to_ascii_lowercase();
                if !JOURNAL_MODES.contains(&mode.as_str()) {
                    return Err(DriverError::invalid(format!(
                        "journal_mode is one of {}",
                        JOURNAL_MODES.join(", ")
                    )));
                }
                if read_only {
                    return Err(DriverError::invalid(
                        "A read-only connection cannot change the journal of its file",
                    ));
                }
                found.journal_mode = Some(mode);
            }
            "busy_timeout" => {
                found.busy_timeout = value
                    .trim()
                    .parse()
                    .ok()
                    .filter(|milliseconds| *milliseconds <= 600_000)
                    .ok_or_else(|| {
                        DriverError::invalid("busy_timeout is milliseconds, from 0 to 600000")
                    })?;
            }
            other => {
                return Err(DriverError::invalid(format!(
                    "SQLite does not take the setting {other}: use {}",
                    SETTINGS.join(", ")
                )));
            }
        }
    }
    Ok(found)
}

/// Opens the file and sets the session up; the hooks go last, once its own pragmas ran.
fn open(params: &ConnectParams) -> Result<(Connection, Guard, ServerInfo)> {
    let settings = settings(&params.options, params.read_only)?;
    let target = file::target(
        params.database.as_deref(),
        settings.create,
        params.read_only,
    )?;
    let path = target.path.as_path();
    let failed = |error| errors::opening(error, path, None);
    let mut conn = Connection::open_with_flags(path, target.flags).map_err(failed)?;
    conn.busy_timeout(Duration::from_millis(settings.busy_timeout))
        .map_err(failed)?;
    conn.pragma_update(None, "foreign_keys", settings.foreign_keys)
        .map_err(failed)?;
    if let Some(mode) = &settings.journal_mode {
        let _: String = conn
            .pragma_update_and_check(None, "journal_mode", mode, |row| row.get(0))
            .map_err(failed)?;
    }
    if params.read_only {
        conn.pragma_update(None, "query_only", true)
            .map_err(failed)?;
    }
    let guard = Guard::install(&mut conn, params.read_only).map_err(failed)?;
    // Reading the schema: a file that is not a database says so here, not later.
    let tables: rusqlite::Result<i64> =
        conn.query_row("SELECT count(*) FROM sqlite_schema", [], |row| row.get(0));
    tables.map_err(|error| errors::opening(error, path, Some(&guard)))?;
    let server = ServerInfo {
        server_version: rusqlite::version().to_owned(),
        product: None,
        database: path
            .file_name()
            .map(|name| name.to_string_lossy().into_owned()),
        user: None,
        tls: false,
    };
    Ok((conn, guard, server))
}

/// The statement running now, by the name the host gave it.
#[derive(Default)]
pub(crate) struct Running {
    statement: Mutex<Option<String>>,
}
impl Running {
    pub fn start(&self, statement: &str) {
        *self.statement.lock().unwrap() = Some(statement.to_owned());
    }
    pub fn stop(&self) {
        *self.statement.lock().unwrap() = None;
    }
}

pub(crate) struct SqliteConnection {
    commands: mpsc::Sender<Command>,
    closed: Arc<AtomicBool>,
    interrupt: InterruptHandle,
    running: Arc<Running>,
}

pub(crate) fn not_open() -> DriverError {
    DriverError::invalid("The connection is not open")
}
fn ended() -> DriverError {
    DriverError::closed("The connection was closed: connect again")
}

impl SqliteConnection {
    /// Opens a connection on a thread of its own, which keeps it until it is dropped.
    pub async fn open(params: ConnectParams) -> Result<(Self, ServerInfo)> {
        let (commands, receiver) = mpsc::channel(8);
        let (opened, opening) = oneshot::channel();
        let closed = Arc::new(AtomicBool::new(false));
        let running = Arc::new(Running::default());
        let (closing, session_running) = (closed.clone(), running.clone());
        std::thread::Builder::new()
            .name("sqlite-session".into())
            .spawn(move || match open(&params) {
                Ok((conn, guard, server)) => {
                    let interrupt = conn.get_interrupt_handle();
                    if opened.send(Ok((server, interrupt))).is_ok() {
                        session::serve(conn, guard, receiver, session_running);
                    }
                    closing.store(true, Ordering::Relaxed);
                }
                Err(error) => {
                    let _ = opened.send(Err(error));
                }
            })
            .map_err(|error| DriverError::internal(error.to_string()))?;
        let (server, interrupt) = tokio::time::timeout(limits::CONNECT, opening)
            .await
            .map_err(|_| DriverError::timeout("The database file stayed locked"))?
            .map_err(|_| ended())??;
        let connection = Self {
            commands,
            closed,
            interrupt,
            running,
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
        self.commands
            .send(command(reply))
            .await
            .map_err(|_| ended())?;
        answer.await.map_err(|_| ended())?
    }

    /// Every row of a catalog query.
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
    /// Interrupts the statement named `statement`, if it is the one running.
    pub fn cancel(&self, statement: &str) {
        let running = self.running.statement.lock().unwrap();
        if running.as_deref() == Some(statement) {
            self.interrupt.interrupt();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn takes_a_closed_list_of_settings() {
        let options = |pairs: &[(&str, &str)]| {
            pairs
                .iter()
                .map(|(name, value)| ((*name).to_owned(), (*value).to_owned()))
                .collect::<BTreeMap<_, _>>()
        };
        let found = settings(
            &options(&[("create", "yes"), ("journal_mode", "WAL")]),
            false,
        );
        let found = found.ok().unwrap();
        assert!(found.create && found.foreign_keys);
        assert_eq!(found.journal_mode.as_deref(), Some("wal"));
        for wrong in [
            ("journal_mode", "fast"),
            ("busy_timeout", "-1"),
            ("create", "maybe"),
            ("key", "secret"),
        ] {
            assert!(settings(&options(&[wrong]), false).is_err(), "{wrong:?}");
        }
        assert!(settings(&options(&[("journal_mode", "wal")]), true).is_err());
    }
}
