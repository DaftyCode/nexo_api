//! The databases of the modules (`db.*`). A session is opened on a saved connection and
//! keeps what the rules need (read-only, production), so a statement only names its
//! session. Every statement is checked by `rules` before its driver sees it and recorded in
//! the history; the connection's vault values never come back in an answer or an error.
mod connection;
mod history;
mod rules;
mod sessions;
#[cfg(test)]
mod tests;

pub(crate) use sessions::Sessions;

use crate::{
    Application,
    operations::Operation,
    payloads::{
        DbCancelPayload, DbConnectPayload, DbCursorPayload, DbDriverPayload, DbExecutePayload,
        DbObjectPayload, DbSessionPayload, DbSplitPayload, DbTestPayload, DbTransactionPayload,
    },
    ports::{DataSources, StatementRequest},
    vault::{redact_error, redact_secrets},
};
use nexo_domain::{
    Error, Result, WorkspaceId,
    sql::{ConnectionType, Dialect, classify, split, statement_at, validate_connection},
};
use serde::de::DeserializeOwned;
use serde_json::{Value, json};
use sessions::{Session, session_name};
use std::time::{Duration, Instant};

const TRANSACTION_ACTIONS: [&str; 6] = ["status", "begin", "commit", "rollback", "auto", "manual"];

/// Reads a payload already checked against its type.
fn read<T: DeserializeOwned>(payload: Value) -> Result<T> {
    serde_json::from_value(payload).map_err(|error| Error::Validation(error.to_string()))
}

/// An answer of a session's driver without the session's vault values.
fn redacted(answer: Result<Value>, session: &Session) -> Result<Value> {
    answer
        .map(|value| redact_secrets(value, &session.secrets))
        .map_err(|error| redact_error(error, &session.secrets))
}

/// The statements of a script, what each one does, and the one at `offset`.
fn split_script(payload: DbSplitPayload) -> Result<Value> {
    let dialect = Dialect::parse(payload.dialect.as_deref().unwrap_or_default());
    let statements = split(&payload.script, dialect);
    let current = payload.offset.and_then(|offset| {
        let found = statement_at(&statements, offset as usize)?;
        statements.iter().position(|statement| statement == found)
    });
    let listed: Vec<Value> = statements
        .iter()
        .map(|statement| {
            let mut value = json!(statement);
            value["classification"] = json!(classify(&statement.text, dialect));
            value
        })
        .collect();
    Ok(json!({"statements": listed, "current": current}))
}

impl Application {
    pub(crate) async fn datasource(&self, operation: Operation, payload: Value) -> Result<Value> {
        if operation == Operation::DbSplit {
            return split_script(read(payload)?);
        }
        let sources = self.datasources.clone().ok_or_else(|| {
            Error::Unavailable("Database connections are not available here".into())
        })?;
        let sources = sources.as_ref();
        match operation {
            Operation::DbDialect => {
                let payload: DbDriverPayload = read(payload)?;
                sources.driver(&payload.driver).await
            }
            Operation::DbTest => self.test_connection(sources, read(payload)?).await,
            Operation::DbConnect => self.connect_session(sources, read(payload)?).await,
            Operation::DbDisconnect => {
                let payload: DbSessionPayload = read(payload)?;
                let name = session_name(&payload.session)?;
                self.sql_sessions.remove(name);
                sources.disconnect(name).await.map(|()| json!({}))
            }
            Operation::DbTree | Operation::DbDescribe | Operation::DbDdl => {
                let payload: DbObjectPayload = read(payload)?;
                let session = self.sql_sessions.get(&payload.session)?;
                let (name, path) = (&payload.session, payload.path.unwrap_or_default());
                let answer = match operation {
                    Operation::DbTree => sources.tree(name, path).await,
                    Operation::DbDescribe => sources.describe(name, path).await,
                    _ => sources.ddl(name, path).await,
                };
                redacted(answer, &session)
            }
            Operation::DbExecute => self.execute_statement(sources, read(payload)?).await,
            Operation::DbFetch | Operation::DbClose => {
                let payload: DbCursorPayload = read(payload)?;
                let session = self.sql_sessions.get(&payload.session)?;
                let (name, cursor) = (&payload.session, &payload.cursor);
                let answer = if operation == Operation::DbFetch {
                    sources.fetch(name, cursor, payload.page_rows).await
                } else {
                    sources.close(name, cursor).await.map(|()| json!({}))
                };
                redacted(answer, &session)
            }
            Operation::DbCancel => {
                let payload: DbCancelPayload = read(payload)?;
                let session = self.sql_sessions.get(&payload.session)?;
                let answer = sources.cancel(&payload.session, &payload.statement).await;
                redacted(answer.map(|()| json!({})), &session)
            }
            Operation::DbTransaction => {
                let payload: DbTransactionPayload = read(payload)?;
                if !TRANSACTION_ACTIONS.contains(&payload.action.as_str()) {
                    return Err(Error::Validation(format!(
                        "Unknown transaction action {}",
                        payload.action
                    )));
                }
                let session = self.sql_sessions.get(&payload.session)?;
                let answer = sources
                    .transaction(&payload.session, &payload.action, payload.isolation)
                    .await;
                redacted(answer, &session)
            }
            _ => Err(Error::Validation(format!(
                "{operation} is not an operation of the database connections"
            ))),
        }
    }

    /// Opens a connection, saved or being written, measures it and closes it.
    async fn test_connection(
        &self,
        sources: &dyn DataSources,
        payload: DbTestPayload,
    ) -> Result<Value> {
        let value = match (payload.connection, payload.connection_id) {
            (Some(connection), _) => {
                let value = Value::Object(connection);
                validate_connection(&value)?;
                value
            }
            (None, Some(id)) => {
                let workspace = WorkspaceId::parse(payload.workspace.unwrap_or_default())?;
                self.saved_sql_connection(&workspace, &id).await?.value
            }
            (None, None) => return Err(Error::Validation("Choose a connection to test".into())),
        };
        let mut values = Vec::new();
        let variables = payload.variables.unwrap_or_default();
        let answer = match self
            .resolve_sql_connection(&value, &variables, &mut values)
            .await
        {
            Ok(connection) => sources.test(connection).await,
            Err(error) => Err(error),
        };
        answer
            .map(|value| redact_secrets(value, &values))
            .map_err(|error| redact_error(error, &values))
    }

    /// Opens a session on a saved connection; a session of the same name is closed first.
    async fn connect_session(
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
        let connection = self
            .resolve_sql_connection(&stored.value, &variables, &mut values)
            .await
            .map_err(|error| redact_error(error, &values))?;
        let session = Session {
            workspace,
            connection: stored.id.clone(),
            name: stored.name.clone(),
            driver: connection.driver.clone(),
            read_only: connection.read_only,
            kind: ConnectionType::of(&stored.value),
            timeout: stored.value["timeoutSeconds"]
                .as_u64()
                .map(Duration::from_secs),
            secrets: values.clone(),
        };
        self.sql_sessions.insert(name, session)?;
        match sources.connect(name, connection).await {
            Ok(server) => Ok(redact_secrets(server, &values)),
            Err(error) => {
                self.sql_sessions.remove(name);
                Err(redact_error(error, &values))
            }
        }
    }

    /// Runs one statement of a session after its rules, and records it in the history.
    async fn execute_statement(
        &self,
        sources: &dyn DataSources,
        payload: DbExecutePayload,
    ) -> Result<Value> {
        let session = self.sql_sessions.get(session_name(&payload.session)?)?;
        let classification = rules::classify_all(&payload.sql, Dialect::parse(&session.driver));
        let confirm = payload.confirm.unwrap_or(false);
        rules::check(
            &session,
            &classification,
            confirm,
            payload.confirm_name.as_deref(),
        )?;
        let request = StatementRequest {
            statement: payload.statement,
            sql: payload.sql.clone(),
            params: payload.params.unwrap_or_default(),
            page_rows: payload.page_rows,
            max_rows: payload.max_rows,
            timeout: session.timeout,
        };
        let started = Instant::now();
        let answer = sources.execute(&payload.session, request).await;
        let took = started.elapsed();
        match redacted(answer, &session) {
            Ok(value) => {
                self.record_statement(&session, &payload.sql, took, Ok(&value))
                    .await;
                Ok(value)
            }
            Err(error) => {
                let message = error.to_string();
                self.record_statement(&session, &payload.sql, took, Err(message))
                    .await;
                Err(error)
            }
        }
    }
}
