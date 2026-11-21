//! The options of a backup, a restore and a script, read from closed lists.
use super::{file_path, invalid, object_name};
use crate::Result;
use serde_json::Value;

/// How a PostgreSQL backup is written; MySQL and MariaDB write SQL only.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BackupFormat {
    Plain,
    Custom,
    Directory,
    Tar,
}

impl BackupFormat {
    fn parse(text: &str) -> Result<Self> {
        Ok(match text {
            "plain" => Self::Plain,
            "custom" => Self::Custom,
            "directory" => Self::Directory,
            "tar" => Self::Tar,
            _ => return Err(invalid("A backup is plain SQL, custom, directory or tar")),
        })
    }
    pub fn name(self) -> &'static str {
        match self {
            Self::Plain => "plain",
            Self::Custom => "custom",
            Self::Directory => "directory",
            Self::Tar => "tar",
        }
    }
}

/// What a backup keeps of the objects.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Content {
    All,
    Schema,
    Data,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Backup {
    /// Every database of the server (`pg_dumpall`), not the one of the connection.
    pub server: bool,
    pub schemas: Vec<String>,
    /// Tables by schema (PostgreSQL; it may be left out) and name.
    pub tables: Vec<(Option<String>, String)>,
    pub format: BackupFormat,
    pub content: Content,
    pub no_owner: bool,
    pub no_privileges: bool,
    /// `INSERT` statements instead of `COPY` (PostgreSQL) or one per row (MySQL).
    pub inserts: bool,
    /// 0 to 9, for the formats that compress.
    pub compress: Option<u8>,
    pub path: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Restore {
    pub path: String,
    /// How the backup was written: plain SQL goes to `psql`, the rest to `pg_restore`.
    pub format: BackupFormat,
    /// Drops the objects of the backup before making them again.
    pub clean: bool,
    pub data_only: bool,
    pub single_transaction: bool,
    pub no_owner: bool,
    pub no_privileges: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Script {
    pub path: String,
    pub stop_on_error: bool,
}

fn flag(options: &Value, key: &str) -> bool {
    options[key] == Value::Bool(true)
}

fn names(options: &Value, key: &str) -> Result<Vec<String>> {
    let names = options[key]
        .as_array()
        .map(Vec::as_slice)
        .unwrap_or_default();
    if names.len() > 1000 {
        return Err(invalid("A backup names at most 1000 schemas or tables"));
    }
    names
        .iter()
        .map(|name| object_name(name.as_str().unwrap_or_default()).map(String::from))
        .collect()
}

fn path(options: &Value) -> Result<String> {
    file_path(options["path"].as_str().unwrap_or_default()).map(String::from)
}

impl Backup {
    pub fn read(options: &Value) -> Result<Self> {
        let content = match options["content"].as_str().unwrap_or("all") {
            "all" => Content::All,
            "schema" => Content::Schema,
            "data" => Content::Data,
            _ => {
                return Err(invalid(
                    "A backup keeps everything, the structure or the data",
                ));
            }
        };
        let compress = match &options["compress"] {
            Value::Null => None,
            level => Some(
                level
                    .as_u64()
                    .filter(|level| *level <= 9)
                    .ok_or_else(|| invalid("The compression is a level from 0 to 9"))?
                    as u8,
            ),
        };
        let listed = options["tables"]
            .as_array()
            .map(Vec::as_slice)
            .unwrap_or_default();
        if listed.len() > 1000 {
            return Err(invalid("A backup names at most 1000 schemas or tables"));
        }
        // A table is its name, or `{schema, name}`: a name may have dots of its own.
        let tables = listed
            .iter()
            .map(|table| {
                let name = table["name"]
                    .as_str()
                    .or(table.as_str())
                    .unwrap_or_default();
                let schema = table["schema"].as_str().map(object_name).transpose()?;
                Ok((schema.map(String::from), object_name(name)?.to_string()))
            })
            .collect::<Result<_>>()?;
        Ok(Self {
            server: flag(options, "server"),
            schemas: names(options, "schemas")?,
            tables,
            format: BackupFormat::parse(options["format"].as_str().unwrap_or("plain"))?,
            content,
            no_owner: flag(options, "noOwner"),
            no_privileges: flag(options, "noPrivileges"),
            inserts: flag(options, "inserts"),
            compress,
            path: path(options)?,
        })
    }
}

impl Restore {
    pub fn read(options: &Value) -> Result<Self> {
        Ok(Self {
            path: path(options)?,
            format: BackupFormat::parse(options["format"].as_str().unwrap_or("plain"))?,
            clean: flag(options, "clean"),
            data_only: flag(options, "dataOnly"),
            single_transaction: flag(options, "singleTransaction"),
            no_owner: flag(options, "noOwner"),
            no_privileges: flag(options, "noPrivileges"),
        })
    }
}

impl Script {
    pub fn read(options: &Value) -> Result<Self> {
        Ok(Self {
            path: path(options)?,
            stop_on_error: options["stopOnError"] != Value::Bool(false),
        })
    }
}
