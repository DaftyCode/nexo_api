//! The execution plan of a statement (`db.explain`). The estimated plan runs nothing, so
//! any statement may be explained, also on a read-only connection. The actual plan runs the
//! statement to measure it: never a change of structure (some engines commit it on their
//! own, none can be sure to undo it), and a change only once confirmed, never on a read-only
//! connection, and always inside a transaction its driver rolls back.
use super::{redacted, rules, sessions::session_name};
use crate::{Application, payloads::DbExplainPayload, ports::DataSources};
use nexo_domain::{
    Error, Result,
    sql::{Dialect, StatementKind},
};
use serde_json::{Value, json};

fn refused(message: impl Into<String>) -> Error {
    Error::Validation(message.into())
}

impl Application {
    pub(super) async fn explain_statement(
        &self,
        sources: &dyn DataSources,
        payload: DbExplainPayload,
    ) -> Result<Value> {
        let session = self.sql_sessions.get(session_name(&payload.session)?)?;
        let actual = match payload.mode.as_deref().unwrap_or("estimated") {
            "estimated" => false,
            "actual" => true,
            other => return Err(refused(format!("Unknown plan mode: {other}"))),
        };
        let classification = rules::classify_all(&payload.sql, Dialect::parse(&session.driver));
        let writes = classification.kind == StatementKind::Write;
        if actual {
            if classification.kind == StatementKind::Structure || classification.truncate {
                return Err(refused(
                    "The actual plan runs the statement, and a change of structure cannot be undone: explain it estimated",
                ));
            }
            if matches!(
                classification.kind,
                StatementKind::Transaction | StatementKind::Session
            ) {
                return Err(refused("Only a query or a change has a plan"));
            }
            if writes && session.read_only {
                return Err(refused(format!(
                    "The connection {} is read-only: the actual plan would run this change, so explain it estimated",
                    session.name
                )));
            }
            if writes && !payload.confirm.unwrap_or(false) {
                return Err(refused(
                    "Confirm the actual plan: it runs the change and rolls it back",
                ));
            }
        }
        let request = json!({
            "connection": payload.session,
            "statement": payload.statement,
            "sql": payload.sql,
            "params": payload.params.unwrap_or_default(),
            "mode": if actual { "actual" } else { "estimated" },
            "writes": writes,
        });
        redacted(sources.explain(&payload.session, request).await, &session)
    }
}
