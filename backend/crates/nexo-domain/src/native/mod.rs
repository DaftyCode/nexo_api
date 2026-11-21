//! The local client tools of the database engines (DB-23): backups with `pg_dump`,
//! `pg_dumpall` and `mysqldump`/`mariadb-dump`, restores with `pg_restore`, `psql` and
//! `mysql`/`mariadb`, and `.sql` scripts run with the client.
//!
//! This module only builds what to run: the tool, its arguments, its environment and the
//! temporary files it reads. Every argument comes from a closed option; the names of objects
//! are values of their option (`--table=…`), quoted so that the tool reads them as names; no
//! text becomes an option. The password and the server never go in the arguments: libpq
//! reads them from its environment (`PGPASSWORD`…) and the MySQL clients from a temporary
//! options file (`--defaults-extra-file`). [`TEMP`] stands for the private folder of those
//! files, which the adapter makes for each run and deletes after it.
mod mysql;
mod options;
mod postgres;

#[cfg(test)]
mod tests;

pub use options::{Backup, BackupFormat, Content, Restore, Script};

use crate::{Error, Result};

/// Stands for the private temporary folder of a run, in arguments, environment and files.
/// It has control characters, which no name or path accepted here has.
pub const TEMP: &str = "\u{1}temp\u{1}";

/// The tools Nexo runs, by the exact name of their executable (without `.exe`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Tool {
    PgDump,
    PgDumpAll,
    PgRestore,
    Psql,
    MysqlDump,
    Mysql,
    MariadbDump,
    Mariadb,
}

impl Tool {
    pub const ALL: [Tool; 8] = [
        Tool::PgDump,
        Tool::PgDumpAll,
        Tool::PgRestore,
        Tool::Psql,
        Tool::MysqlDump,
        Tool::Mysql,
        Tool::MariadbDump,
        Tool::Mariadb,
    ];

    pub fn name(self) -> &'static str {
        match self {
            Tool::PgDump => "pg_dump",
            Tool::PgDumpAll => "pg_dumpall",
            Tool::PgRestore => "pg_restore",
            Tool::Psql => "psql",
            Tool::MysqlDump => "mysqldump",
            Tool::Mysql => "mysql",
            Tool::MariadbDump => "mariadb-dump",
            Tool::Mariadb => "mariadb",
        }
    }

    pub fn parse(name: &str) -> Option<Tool> {
        Tool::ALL.into_iter().find(|tool| tool.name() == name)
    }
}

/// What a backup, restore or script needs of its engine's tools.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Need {
    Backup,
    BackupServer,
    RestoreArchive,
    RestorePlain,
    Script,
}

/// The tools that can do something for a driver, the preferred first: MySQL and MariaDB
/// share a driver, and each one's install has the client of its name.
pub fn candidates(driver: &str, need: Need) -> Result<&'static [Tool]> {
    Ok(match (driver, need) {
        ("postgres", Need::Backup) => &[Tool::PgDump],
        ("postgres", Need::BackupServer) => &[Tool::PgDumpAll],
        ("postgres", Need::RestoreArchive) => &[Tool::PgRestore],
        ("postgres", Need::RestorePlain | Need::Script) => &[Tool::Psql],
        ("mysql", Need::Backup) => &[Tool::MysqlDump, Tool::MariadbDump],
        ("mysql", Need::RestorePlain | Need::Script) => &[Tool::Mysql, Tool::Mariadb],
        ("mysql", _) => {
            return Err(invalid(
                "MySQL and MariaDB back up a database at a time, as SQL",
            ));
        }
        _ => {
            return Err(invalid(
                "The local client tools are for PostgreSQL, MySQL and MariaDB connections",
            ));
        }
    })
}

/// Where the tool connects, with its credentials, once the connection is resolved.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Target {
    pub host: String,
    pub port: u16,
    /// The address the egress policy checked, when the tool must use it and not the name.
    pub address: Option<String>,
    pub user: Option<String>,
    pub password: Option<String>,
    pub database: Option<String>,
    /// `disable`, `prefer`, `require` or `verify`, as connections store it.
    pub tls: String,
    /// The certificate authority to verify the server with, PEM.
    pub ca_pem: Option<String>,
}

/// What to run: a tool with its arguments, environment and temporary files.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Invocation {
    pub tool: Tool,
    pub args: Vec<String>,
    pub env: Vec<(String, String)>,
    /// Files of the temporary folder, by name, with what they hold.
    pub files: Vec<(String, String)>,
    /// A file whose content goes to the standard input (the MySQL clients read scripts so).
    pub stdin: Option<String>,
}

impl Invocation {
    fn new(tool: Tool) -> Self {
        Self {
            tool,
            args: Vec::new(),
            env: Vec::new(),
            files: Vec::new(),
            stdin: None,
        }
    }
    fn arg(&mut self, option: &str, value: &str) {
        self.args.push(format!("{option}={value}"));
    }
    fn flag(&mut self, flag: &str, on: bool) {
        if on {
            self.args.push(flag.to_string());
        }
    }
}

fn invalid(message: &str) -> Error {
    Error::Validation(message.into())
}

/// A text that becomes a value: no control characters (nor the [`TEMP`] mark).
fn plain(text: &str, what: &str) -> Result<()> {
    if text.chars().any(char::is_control) {
        return Err(Error::Validation(format!(
            "The {what} cannot have line breaks or control characters"
        )));
    }
    Ok(())
}

/// The name of a schema, table or database: 1 to 256 characters, no control characters.
pub fn object_name(name: &str) -> Result<&str> {
    if name.is_empty() || name.chars().count() > 256 {
        return Err(Error::Validation(format!("The name {name:?} is not valid")));
    }
    plain(name, "name")?;
    Ok(name)
}

/// A file or folder the person chose: a whole path, so that it never reads as an option.
pub fn file_path(path: &str) -> Result<&str> {
    plain(path, "path")?;
    let absolute = std::path::Path::new(path).is_absolute();
    if path.len() > 4096 || !absolute || path.starts_with('-') {
        return Err(invalid(
            "Choose the file with the dialog: its whole path is needed",
        ));
    }
    Ok(path)
}

/// What a backup runs, with the tool found for it.
pub fn backup(tool: Tool, target: &Target, backup: &Backup, mariadb: bool) -> Result<Invocation> {
    match tool {
        Tool::PgDump | Tool::PgDumpAll => postgres::backup(tool, target, backup),
        Tool::MysqlDump | Tool::MariadbDump => mysql::backup(tool, target, backup, mariadb),
        _ => Err(invalid("This tool does not make backups")),
    }
}

/// What a restore runs, with the tool found for it.
pub fn restore(
    tool: Tool,
    target: &Target,
    restore: &Restore,
    mariadb: bool,
) -> Result<Invocation> {
    match tool {
        Tool::PgRestore | Tool::Psql => postgres::restore(tool, target, restore),
        Tool::Mysql | Tool::Mariadb => mysql::input(tool, target, &restore.path, true, mariadb),
        _ => Err(invalid("This tool does not restore backups")),
    }
}

/// What running a script with the client runs.
pub fn script(tool: Tool, target: &Target, script: &Script, mariadb: bool) -> Result<Invocation> {
    match tool {
        Tool::Psql => postgres::script(target, script),
        Tool::Mysql | Tool::Mariadb => {
            mysql::input(tool, target, &script.path, script.stop_on_error, mariadb)
        }
        _ => Err(invalid("This tool does not run scripts")),
    }
}
