//! Rows changed in the data grid, written as one by the session's driver after the rules any
//! statement has: never on a read-only connection; on production, and when many rows are
//! deleted, only once confirmed. The save goes to the history (its statements, with
//! placeholders instead of values) and to the log of the session's transaction.
use super::{redacted, sessions::session_name};
use crate::{Application, payloads::DbRowsWritePayload, ports::DataSources};
use nexo_domain::{Error, Result, sql::ConnectionType};
use serde_json::{Value, json};
use std::time::Instant;

/// Deleted rows that need a confirmation, whatever the connection.
const MANY_DELETED: usize = 100;

fn refused(message: impl Into<String>) -> Error {
    Error::Validation(message.into())
}

impl Application {
    pub(super) async fn write_rows(
        &self,
        sources: &dyn DataSources,
        payload: DbRowsWritePayload,
    ) -> Result<Value> {
        let session = self.sql_sessions.get(session_name(&payload.session)?)?;
        if session.read_only {
            return Err(refused(format!(
                "The connection {} is read-only: its rows cannot change",
                session.name
            )));
        }
        if payload.changes.is_empty() {
            return Err(refused("There is nothing to save"));
        }
        let confirm = payload.confirm.unwrap_or(false);
        let deleted = payload
            .changes
            .iter()
            .filter(|change| change["kind"] == "delete")
            .count();
        if deleted > MANY_DELETED && !confirm {
            return Err(refused(format!(
                "Confirm the save: it deletes {deleted} rows"
            )));
        }
        if session.kind == ConnectionType::Production && !confirm {
            return Err(refused(format!(
                "The connection {} is for production: confirm the save before it changes anything",
                session.name
            )));
        }
        let request = json!({
            "connection": payload.session,
            "schema": payload.schema,
            "table": payload.table,
            "changes": payload.changes,
            "optimistic": payload.optimistic.unwrap_or(false),
        });
        let started = Instant::now();
        let answer = redacted(
            sources.write_rows(&payload.session, request).await,
            &session,
        );
        let took = started.elapsed();
        let sql = match &answer {
            Ok(written) => written["statements"]
                .as_array()
                .map(|all| {
                    all.iter()
                        .filter_map(Value::as_str)
                        .collect::<Vec<_>>()
                        .join(";\n")
                })
                .unwrap_or_default(),
            Err(_) => format!("-- {} changes to {}", payload.changes.len(), payload.table),
        };
        let outcome = answer.as_ref().map_err(ToString::to_string);
        self.record_statement(&session, &sql, took, outcome).await;
        if let Ok(written) = &answer {
            let affected = written["affected"].as_u64();
            session
                .journal
                .lock()
                .unwrap()
                .statement(&sql, took, affected, true);
            self.hold_open(sources, &payload.session, &session).await;
        }
        answer
    }
}
