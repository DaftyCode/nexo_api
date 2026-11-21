//! Backups, restores and scripts with the local client tools of a connection's engine
//! (DB-23, desktop only): the tool found for each, the rules it follows (a read-only
//! connection restores and runs nothing; a restore needs the database typed, and on
//! production also a confirmation, as a script does), and the run the adapter starts.
use crate::{
    Application,
    operations::Operation,
    payloads::{IdPayload, NativeLocatePayload, NativeRunPayload},
    ports::{NativeJob, NativeTools},
    vault::redact_error,
};
use nexo_domain::{
    DocumentKind, Error, Result, WorkspaceId,
    native::{self, Backup, BackupFormat, Need, Restore, Script, Target},
    sql::ConnectionType,
};
use serde_json::{Map, Value, json};
use std::time::Duration;

fn invalid(message: impl Into<String>) -> Error {
    Error::Validation(message.into())
}

fn parse<T: serde::de::DeserializeOwned>(payload: Map<String, Value>) -> Result<T> {
    serde_json::from_value(Value::Object(payload)).map_err(|error| invalid(error.to_string()))
}

fn need(text: Option<&str>) -> Result<Need> {
    Ok(match text.unwrap_or("backup") {
        "backup" => Need::Backup,
        "server" => Need::BackupServer,
        "archive" => Need::RestoreArchive,
        "plain" => Need::RestorePlain,
        "script" => Need::Script,
        _ => return Err(invalid("Unknown local client action")),
    })
}

/// The local client folder a connection names, if any.
fn folder(value: &Value) -> Option<String> {
    value["localClient"]
        .as_str()
        .map(str::trim)
        .filter(|folder| !folder.is_empty())
        .map(String::from)
}

/// What a run does, with its options read.
enum Action {
    Backup(Backup),
    Restore(Restore),
    Script(Script),
}

impl Application {
    fn native_tools(&self) -> Result<&dyn NativeTools> {
        self.native.as_deref().ok_or_else(|| {
            invalid("Backups, restores and scripts with the local client are in the desktop app")
        })
    }

    pub(crate) async fn native(
        &self,
        operation: Operation,
        payload: Map<String, Value>,
    ) -> Result<Value> {
        let tools = self.native_tools()?;
        match operation {
            Operation::NativeStatus => tools.status(&parse::<IdPayload>(payload)?.id).await,
            Operation::NativeCancel => {
                tools.cancel(&parse::<IdPayload>(payload)?.id).await?;
                Ok(json!({"cancelled": true}))
            }
            Operation::NativeLocate => {
                let payload: NativeLocatePayload = parse(payload)?;
                let workspace = WorkspaceId::parse(payload.workspace.unwrap_or_default())?;
                let stored = self
                    .saved_sql_connection(&workspace, &payload.connection)
                    .await?;
                let driver = stored.value["driver"].as_str().unwrap_or_default();
                let candidates = native::candidates(driver, need(payload.need.as_deref())?)?;
                let folder = payload.folder.or_else(|| folder(&stored.value));
                let found = tools.locate(folder.as_deref(), candidates).await?;
                Ok(json!({"tool": found.tool.name(), "path": found.path, "version": found.version}))
            }
            _ => self.native_run(tools, operation, parse(payload)?).await,
        }
    }

    async fn native_run(
        &self,
        tools: &dyn NativeTools,
        operation: Operation,
        payload: NativeRunPayload,
    ) -> Result<Value> {
        let workspace = WorkspaceId::parse(payload.workspace.unwrap_or_default())?;
        let stored = self
            .saved_sql_connection(&workspace, &payload.connection)
            .await?;
        debug_assert_eq!(stored.kind, DocumentKind::Connection);
        let (action, need) = match operation {
            Operation::NativeBackup => {
                let backup = Backup::read(&payload.options)?;
                let need = if backup.server {
                    Need::BackupServer
                } else {
                    Need::Backup
                };
                (Action::Backup(backup), need)
            }
            Operation::NativeRestore => {
                let restore = Restore::read(&payload.options)?;
                let need = if restore.format == BackupFormat::Plain {
                    Need::RestorePlain
                } else {
                    Need::RestoreArchive
                };
                (Action::Restore(restore), need)
            }
            _ => (
                Action::Script(Script::read(&payload.options)?),
                Need::Script,
            ),
        };
        let mut values = Vec::new();
        let variables = payload.variables.unwrap_or_default();
        let connection = self
            .resolve_sql_connection(Some(&workspace), &stored.value, &variables, &mut values)
            .await
            .map_err(|error| redact_error(error, &values))?;
        // The client tools connect on their own: they cannot take the host's forwarded port.
        if !connection.route.is_direct() {
            return Err(invalid(
                "The local client tools cannot go through a SOCKS5 proxy or an SSH tunnel: use a direct connection",
            ));
        }
        let database = payload
            .database
            .map(|name| name.trim().to_owned())
            .filter(|name| !name.is_empty())
            .or(connection.database.clone());
        if !matches!(action, Action::Backup(_)) {
            if connection.read_only {
                return Err(invalid(format!(
                    "The connection {} is read-only: it restores and runs nothing",
                    stored.name
                )));
            }
            let production = ConnectionType::of(&stored.value) == ConnectionType::Production;
            if production && payload.confirm != Some(true) {
                return Err(invalid(format!(
                    "The connection {} is for production: confirm it before it changes anything",
                    stored.name
                )));
            }
        }
        if matches!(action, Action::Restore(_))
            && payload.confirm_name.as_deref().map(str::trim) != database.as_deref()
        {
            return Err(invalid(
                "Type the name of the database the backup is restored into",
            ));
        }
        if connection.tls.cert_pem.is_some() || connection.tls.key_pem.is_some() {
            return Err(invalid(
                "The local client does not use the client certificate of a connection yet",
            ));
        }
        let driver = connection.driver.as_str();
        let located = tools
            .locate(
                folder(&stored.value).as_deref(),
                native::candidates(driver, need)?,
            )
            .await?;
        let host = connection
            .host
            .clone()
            .ok_or_else(|| invalid("The connection has no server"))?;
        let port = connection
            .port
            .unwrap_or(if driver == "postgres" { 5432 } else { 3306 });
        let address = tools.destination(&host, port).await?;
        let target = Target {
            host,
            port,
            address,
            user: connection.user.clone(),
            password: connection.password.clone(),
            database,
            tls: connection.tls.mode.clone(),
            ca_pem: connection.tls.ca_pem.clone(),
        };
        let mariadb = located.version.contains("MariaDB");
        let (invocation, path) = match &action {
            Action::Backup(backup) => (
                native::backup(located.tool, &target, backup, mariadb)?,
                &backup.path,
            ),
            Action::Restore(restore) => (
                native::restore(located.tool, &target, restore, mariadb)?,
                &restore.path,
            ),
            Action::Script(script) => (
                native::script(located.tool, &target, script, mariadb)?,
                &script.path,
            ),
        };
        let mut secrets: Vec<String> = values.into_iter().map(|(_, value)| value).collect();
        secrets.extend(connection.password.clone());
        let job = NativeJob {
            invocation,
            paths: vec![path.clone()],
            secrets,
            timeout: payload.timeout_seconds.map(Duration::from_secs),
        };
        let id = tools.start(&located, job).await?;
        Ok(json!({"id": id, "tool": located.tool.name(), "version": located.version}))
    }
}
