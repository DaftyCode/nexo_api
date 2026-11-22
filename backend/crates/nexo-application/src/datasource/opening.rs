//! What a session does as it opens (DB-25): the default schema and the startup queries of its
//! connection, under its rules; and opening it again when its connection closed (left unused,
//! dropped by the server, or its driver stopped). What only reads runs again once it is open;
//! nothing that writes ever runs again by itself.
use super::{
    Session,
    passwords::{Source, asking},
    read, redacted,
    rules::classify_all,
    sessions::session_name,
};
use crate::{
    Application,
    operations::Operation,
    payloads::{DbConnectPayload, DbExecutePayload},
    ports::{DataSources, StatementRequest},
    vault::{redact_error, redact_secrets},
};
use nexo_domain::{
    Error, Result, WorkspaceId,
    sql::{Dialect, SessionSettings, StatementKind},
};
use serde_json::{Value, json};
use std::time::Duration;

/// Whether an error says the session's connection is no longer there.
pub(super) fn closed(error: &Error) -> bool {
    matches!(error, Error::Database { code, .. } if code == "closed")
}

/// Whether an operation only reads, so it may run again on the reopened connection.
fn rerunnable(operation: Operation, payload: &Value, session: &Session) -> bool {
    match operation {
        Operation::DbTree
        | Operation::DbDescribe
        | Operation::DbDdl
        | Operation::DbDdlModel
        | Operation::DbSearch
        | Operation::DbDashboards
        | Operation::DbDashboardRead
        | Operation::DbSessions
        | Operation::DbLocks
        | Operation::DbKvScan
        | Operation::DbKvGet => true,
        Operation::DbExecute => read::<DbExecutePayload>(payload.clone()).is_ok_and(|payload| {
            let kind = classify_all(&payload.sql, Dialect::parse(&session.driver)).kind;
            matches!(kind, StatementKind::Read | StatementKind::Session)
        }),
        _ => false,
    }
}

impl Application {
    /// Opens a session on a saved connection; a session of the same name is closed first.
    pub(super) async fn connect_session(
        &self,
        sources: &dyn DataSources,
        payload: DbConnectPayload,
    ) -> Result<Value> {
        let name = session_name(&payload.session)?;
        let workspace = WorkspaceId::parse(payload.workspace.unwrap_or_default())?;
        let stored = self
            .saved_sql_connection(&workspace, &payload.connection_id)
            .await?;
        if self.sql_sessions.remove(name).is_some() {
            let _ = sources.disconnect(name).await;
        }
        let mut values = Vec::new();
        let variables = payload.variables.unwrap_or_default();
        let mut connection = self
            .resolve_sql_connection(Some(&workspace), &stored.value, &variables, &mut values)
            .await
            .map_err(|error| redact_error(error, &values))?;
        if let Some(database) = payload.database.filter(|name| !name.trim().is_empty()) {
            connection.database = Some(database.trim().to_owned());
        }
        let rules = self.type_rules(&workspace, &stored.value).await?;
        // Whoever opens it may ask for less: MCP agents only read (DB-32).
        connection.read_only |= rules.read_only || payload.read_only == Some(true);
        let source = Source::of(&stored.value);
        let remembered = self.sql_sessions.asked(&workspace, &stored.id);
        self.supply_password(
            &source,
            remembered,
            payload.password,
            &mut connection,
            &mut values,
        )
        .await
        .map_err(|error| asking(redact_error(error, &values), &stored.name))?;
        let dialect = Dialect::parse(&connection.driver);
        let settings = SessionSettings::read(&stored.value, dialect, connection.read_only)?;
        let asked = matches!(source, Source::Asked)
            .then(|| connection.password.clone())
            .flatten();
        let session = Session {
            workspace: workspace.clone(),
            connection: stored.id.clone(),
            name: stored.name.clone(),
            driver: connection.driver.clone(),
            read_only: connection.read_only,
            rules,
            timeout: stored.value["timeoutSeconds"]
                .as_u64()
                .map(Duration::from_secs)
                .or(rules.timeout),
            secrets: values.clone(),
            journal: Default::default(),
            opened: connection.clone(),
            opening: settings.opening(Dialect::parse(&connection.driver)),
            ignore_startup_errors: settings.ignore_startup_errors,
        };
        self.sql_sessions.insert(name, session)?;
        let session = self.sql_sessions.get(name)?;
        let opened = async {
            let server = sources.connect(name, connection).await?;
            let mut failed = self.run_opening(sources, name, &session).await;
            // Commits by hand from the start when its type (or the connection) asks.
            let auto = stored.value["autoCommit"]
                .as_bool()
                .unwrap_or(rules.auto_commit);
            if failed.is_ok() && !auto {
                failed = match sources.transaction(name, "manual", None).await {
                    Ok(_) => {
                        session.journal.lock().unwrap().auto_commit = false;
                        failed
                    }
                    Err(error) => Err(error),
                };
            }
            if failed.is_err() {
                let _ = sources.disconnect(name).await;
            }
            Ok::<_, Error>((server, failed?))
        };
        match opened.await {
            Ok((mut server, failed)) => {
                if let Some(password) = asked {
                    self.sql_sessions.remember(&workspace, &stored.id, password);
                }
                // Startup queries that failed while the connection lets them: said.
                if let (Some(fields), false) = (server.as_object_mut(), failed.is_empty()) {
                    fields.insert("startup".into(), Value::Array(failed));
                }
                Ok(redact_secrets(server, &values))
            }
            Err(error) => {
                self.sql_sessions.remove(name);
                Err(redact_error(error, &values))
            }
        }
    }

    /// Runs what a session runs as it opens; answers the startup queries that failed when its
    /// connection lets them fail.
    pub(super) async fn run_opening(
        &self,
        sources: &dyn DataSources,
        name: &str,
        session: &Session,
    ) -> Result<Vec<Value>> {
        let mut failed = Vec::new();
        for (index, sql) in session.opening.iter().enumerate() {
            let statement = format!("startup-{index}");
            let request = StatementRequest {
                statement: statement.clone(),
                sql: sql.clone(),
                page_rows: Some(1),
                timeout: session.timeout,
                ..StatementRequest::default()
            };
            match redacted(sources.execute(name, request).await, session) {
                Ok(answer) if answer["cursor"].is_string() => {
                    let _ = sources.close(name, &statement).await;
                }
                Ok(_) => {}
                Err(error) if session.ignore_startup_errors => {
                    failed.push(json!({"sql": sql, "error": error.to_string()}));
                }
                Err(error) => {
                    return Err(Error::Validation(format!(
                        "The startup query «{sql}» failed: {error}"
                    )));
                }
            }
        }
        Ok(failed)
    }

    /// After an operation found its session's connection closed: opens it again with what
    /// it opened with, and runs the operation again when it only reads (its answer says
    /// `reconnected`). Anything else is not run again: the error says so.
    pub(super) async fn after_closed(
        &self,
        sources: &dyn DataSources,
        operation: Operation,
        payload: Value,
        error: Error,
    ) -> Result<Value> {
        let name = payload["session"].as_str().unwrap_or_default().to_string();
        let Ok(session) = self.sql_sessions.get(&name) else {
            return Err(error);
        };
        if matches!(operation, Operation::DbConnect | Operation::DbDisconnect) {
            return Err(error);
        }
        // The driver may still hold it when the server dropped it: closed first.
        let _ = sources.disconnect(&name).await;
        redacted(
            sources.connect(&name, session.opened.clone()).await,
            &session,
        )?;
        self.run_opening(sources, &name, &session).await?;
        // What waited for a commit is gone with the old connection; manual commits stay.
        let (lost, auto_commit) = {
            let mut journal = session.journal.lock().unwrap();
            let (lost, auto_commit) = (journal.open(), journal.auto_commit);
            journal.state(auto_commit, false);
            (lost, auto_commit)
        };
        if !auto_commit {
            redacted(sources.transaction(&name, "manual", None).await, &session)?;
        }
        if !rerunnable(operation, &payload, &session) {
            let said = if lost {
                " Its open transaction was lost."
            } else {
                ""
            };
            return Err(Error::Database {
                code: "reconnected".into(),
                message: format!(
                    "The connection had closed: Nexo opened it again and ran nothing.{said} Run it again."
                ),
                detail: Some(json!({"transactionLost": lost})),
            });
        }
        let mut answer = Box::pin(self.dispatch(sources, operation, payload)).await?;
        if let Some(fields) = answer.as_object_mut() {
            fields.insert("reconnected".into(), json!(true));
            if lost {
                fields.insert("transactionLost".into(), json!(true));
            }
        }
        Ok(answer)
    }
}
