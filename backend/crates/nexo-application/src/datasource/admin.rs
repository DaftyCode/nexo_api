//! The administration of a database server (DB-21): its sessions (`db.sessions`), who waits
//! for whom (`db.locks`), and cancelling the statement of one of its sessions or ending it
//! (`db.session.kill`). Reading runs on a session of the person's connection. Cancelling and
//! ending change the server: never on a read-only connection, always confirmed, and on a
//! production connection with the id of the session typed. The driver refuses its own
//! session, the one that asks.
use super::{redacted, sessions::session_name};
use crate::{
    Application,
    operations::Operation,
    payloads::{DbAdminPayload, DbSessionKillPayload},
    ports::DataSources,
};
use nexo_domain::{Error, Result, sql::ConnectionType};
use serde_json::{Value, json};

/// The id of a session of the server: digits and the separators some engines use
/// (`sid,serial#`), never SQL.
fn server_session(target: &str) -> Result<&str> {
    let target = target.trim();
    let valid = (1..=40).contains(&target.len())
        && target
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, ',' | '-' | ':'));
    if valid {
        Ok(target)
    } else {
        Err(Error::Validation(format!(
            "{target} is not the id of a session of the server"
        )))
    }
}

impl Application {
    pub(super) async fn server_activity(
        &self,
        sources: &dyn DataSources,
        operation: Operation,
        payload: DbAdminPayload,
    ) -> Result<Value> {
        let session = self.sql_sessions.get(session_name(&payload.session)?)?;
        let request = json!({"connection": payload.session, "statement": payload.statement});
        let answer = if operation == Operation::DbLocks {
            sources.locks(&payload.session, request).await
        } else {
            sources.sessions(&payload.session, request).await
        };
        redacted(answer, &session)
    }

    pub(super) async fn kill_session(
        &self,
        sources: &dyn DataSources,
        payload: DbSessionKillPayload,
    ) -> Result<Value> {
        let session = self.sql_sessions.get(session_name(&payload.session)?)?;
        let target = server_session(&payload.target)?;
        let what = match payload.mode.as_str() {
            "cancel" => "cancel the statement of",
            "terminate" => "end",
            other => {
                return Err(Error::Validation(format!(
                    "{other} is neither cancel nor terminate"
                )));
            }
        };
        if session.read_only {
            return Err(Error::Validation(format!(
                "The connection {} is read-only: it cannot {what} a session of its server",
                session.name
            )));
        }
        if !payload.confirm.unwrap_or(false) {
            return Err(Error::Validation(format!(
                "Confirm that you want to {what} the session {target}"
            )));
        }
        let typed = payload.confirm_name.as_deref().map(str::trim);
        if session.kind == ConnectionType::Production && typed != Some(target) {
            return Err(Error::Validation(format!(
                "The connection {} is for production: type {target} to {what} that session",
                session.name
            )));
        }
        let request = json!({
            "connection": payload.session,
            "statement": payload.statement,
            "session": target,
            "mode": payload.mode,
        });
        redacted(sources.kill(&payload.session, request).await, &session)
    }
}
