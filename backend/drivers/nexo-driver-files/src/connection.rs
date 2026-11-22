//! A connection: a thread of its own owns the DuckDB connection, whose calls block, and does
//! what is asked one thing at a time; the driver talks to it through a channel. Cancelling,
//! and the time limit of a statement, go around the channel with DuckDB's interrupt.
use crate::{
    excel,
    session::{self, Command, Rows},
    target::{self, Target, literal},
};
use duckdb::{AccessMode, Config, Connection, InterruptHandle};
use nexo_driver_sdk::{
    DriverError, Result, Value, limits,
    protocol::{ConnectParams, ServerInfo},
    statements::{ExecuteParams, ExecuteResult, Page},
};
use std::{
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant},
};
use tokio::sync::{mpsc, oneshot};

pub(crate) fn failed(error: duckdb::Error) -> DriverError {
    let message = error.to_string();
    if message.contains("INTERRUPT") || message.contains("Interrupted") {
        return DriverError::cancelled("The statement was cancelled");
    }
    if message.contains("Parser Error") || message.contains("syntax error") {
        return DriverError::syntax(message);
    }
    if message.contains("Permission Error") || message.contains("disabled by configuration") {
        return DriverError::permission(message);
    }
    DriverError::invalid(message)
}

/// The settings that keep DuckDB to the files of the connection: no network, no extension
/// installed or loaded, only these paths read, and the settings locked.
fn config(read_only: bool, database: bool) -> Result<Config> {
    let config = Config::default()
        .enable_autoload_extension(false)
        .and_then(|config| config.with("autoinstall_known_extensions", "false"))
        .and_then(|config| config.with("allow_community_extensions", "false"))
        .and_then(|config| {
            if database && read_only {
                config.access_mode(AccessMode::ReadOnly)
            } else {
                Ok(config)
            }
        })
        .map_err(failed)?;
    Ok(config)
}

/// Opens what the connection names and sets it up; then nothing else can be reached.
fn open(params: &ConnectParams) -> Result<(Connection, bool, ServerInfo)> {
    let readers = target::readers(&params.options)?;
    let target = target::target(params.database.as_deref())?;
    let (conn, files, name) = match &target {
        Target::Database(path) => {
            let conn = Connection::open_with_flags(path, config(params.read_only, true)?)
                .map_err(failed)?;
            let name = path.file_name().map(|n| n.to_string_lossy().into_owned());
            (conn, false, name)
        }
        Target::Files(list) => {
            let conn =
                Connection::open_in_memory_with_flags(config(true, false)?).map_err(failed)?;
            let paths = list
                .iter()
                .filter(|file| file.format != target::Format::Excel)
                .map(|file| literal(&file.path.to_string_lossy()))
                .collect::<Vec<_>>()
                .join(", ");
            conn.execute_batch(&format!(
                "SET allowed_paths = [{paths}]; SET enable_external_access = false;"
            ))
            .map_err(failed)?;
            for file in list {
                if file.format == target::Format::Excel {
                    excel::load(&conn, file, &readers)?;
                } else {
                    conn.execute_batch(&target::view_sql(file, &readers))
                        .map_err(|error| {
                            DriverError::invalid(format!(
                                "{}: {}",
                                file.path.display(),
                                failed(error)
                            ))
                        })?;
                }
            }
            let name = list
                .first()
                .and_then(|file| file.path.parent())
                .and_then(|folder| folder.file_name())
                .map(|n| n.to_string_lossy().into_owned());
            (conn, true, name)
        }
    };
    if !files {
        conn.execute_batch("SET enable_external_access = false;")
            .map_err(failed)?;
    }
    conn.execute_batch("SET lock_configuration = true;")
        .map_err(failed)?;
    let version: String = conn
        .query_row("SELECT version()", [], |row| row.get(0))
        .map_err(failed)?;
    let server = ServerInfo {
        server_version: version.trim_start_matches('v').to_owned(),
        product: Some("DuckDB".into()),
        database: name,
        user: None,
        tls: false,
    };
    Ok((conn, files, server))
}

/// The statement running now, by the name the host gave it, and when it must stop.
#[derive(Default)]
pub(crate) struct Running {
    statement: Mutex<Option<(String, Instant)>>,
}
impl Running {
    pub fn start(&self, statement: &str) {
        *self.statement.lock().unwrap() =
            Some((statement.to_owned(), Instant::now() + limits::STATEMENT));
    }
    pub fn stop(&self) {
        *self.statement.lock().unwrap() = None;
    }
}

pub(crate) struct FilesConnection {
    commands: mpsc::Sender<Command>,
    closed: Arc<AtomicBool>,
    interrupt: Arc<InterruptHandle>,
    running: Arc<Running>,
    pub files: bool,
}

pub(crate) fn not_open() -> DriverError {
    DriverError::invalid("The connection is not open")
}
fn ended() -> DriverError {
    DriverError::closed("The connection was closed: connect again")
}

impl FilesConnection {
    /// Opens a connection on a thread of its own, which keeps it until it is dropped.
    pub async fn open(params: ConnectParams) -> Result<(Self, ServerInfo)> {
        let (commands, receiver) = mpsc::channel(8);
        let (opened, opening) = oneshot::channel();
        let closed = Arc::new(AtomicBool::new(false));
        let running = Arc::new(Running::default());
        let (closing, session_running) = (closed.clone(), running.clone());
        std::thread::Builder::new()
            .name("duckdb-session".into())
            .spawn(move || match open(&params) {
                Ok((conn, files, server)) => {
                    let interrupt = conn.interrupt_handle();
                    if opened.send(Ok((server, interrupt, files))).is_ok() {
                        session::serve(conn, files, receiver, session_running);
                    }
                    closing.store(true, Ordering::Relaxed);
                }
                Err(error) => {
                    let _ = opened.send(Err(error));
                }
            })
            .map_err(|error| DriverError::internal(error.to_string()))?;
        let (server, interrupt, files) = tokio::time::timeout(limits::connect(), opening)
            .await
            .map_err(|_| DriverError::timeout("The files took too long to open"))?
            .map_err(|_| ended())??;
        watch(running.clone(), interrupt.clone(), closed.clone());
        Ok((
            Self {
                commands,
                closed,
                interrupt,
                running,
                files,
            },
            server,
        ))
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
    /// Interrupts the statement named `statement`, if it is the one running.
    pub fn cancel(&self, statement: &str) {
        let running = self.running.statement.lock().unwrap();
        if running.as_ref().is_some_and(|(name, _)| name == statement) {
            self.interrupt.interrupt();
        }
    }
}

/// Interrupts a statement that runs past its time, while the connection lives.
fn watch(running: Arc<Running>, interrupt: Arc<InterruptHandle>, closed: Arc<AtomicBool>) {
    std::thread::Builder::new()
        .name("duckdb-watch".into())
        .spawn(move || {
            while !closed.load(Ordering::Relaxed) {
                std::thread::sleep(Duration::from_millis(200));
                let late = running
                    .statement
                    .lock()
                    .unwrap()
                    .as_ref()
                    .is_some_and(|(_, deadline)| Instant::now() > *deadline);
                if late {
                    interrupt.interrupt();
                    running.stop();
                }
            }
        })
        .ok();
}
