//! Transactions of the sessions: an action on one, what its log holds, and every session
//! with a transaction waiting for a commit or a rollback. A session with one open is kept
//! from being closed for being idle, which would lose it.
use super::{redacted, sessions::Session};
use crate::{
    Application,
    payloads::{DbTransactionPayload, DbTransactionsPayload},
    ports::DataSources,
    vault::redact_secrets,
};
use nexo_domain::{Error, Result, WorkspaceId};
use serde_json::{Value, json};

const TRANSACTION_ACTIONS: [&str; 6] = ["status", "begin", "commit", "rollback", "auto", "manual"];

impl Application {
    /// Begins, ends or reads a session's transaction, or changes how it commits. The answer
    /// says how many statements wait and since when.
    pub(super) async fn transact(
        &self,
        sources: &dyn DataSources,
        payload: DbTransactionPayload,
    ) -> Result<Value> {
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
        let mut value = redacted(answer, &session)?;
        let auto_commit = value["autoCommit"].as_bool().unwrap_or(true);
        let open = value["open"].as_bool().unwrap_or(false);
        let summary = {
            let mut journal = session.journal.lock().unwrap();
            journal.state(auto_commit, open);
            journal.summary()
        };
        let _ = sources.hold(&payload.session, open).await;
        if let (Some(fields), Some(summary)) = (value.as_object_mut(), summary.as_object()) {
            fields.extend(summary.clone());
        }
        Ok(value)
    }

    /// Keeps a session whose transaction a statement left open from closing for idleness.
    pub(super) async fn hold_open(&self, sources: &dyn DataSources, name: &str, session: &Session) {
        let open = session.journal.lock().unwrap().open();
        if open {
            let _ = sources.hold(name, true).await;
        }
    }

    /// The sessions of a workspace with a transaction open: which connection, since when,
    /// and the statements that wait, without the connection's vault values.
    pub(super) fn open_transactions(&self, payload: DbTransactionsPayload) -> Result<Value> {
        let workspace = WorkspaceId::parse(payload.workspace.unwrap_or_default())?;
        let listed: Vec<Value> = self
            .sql_sessions
            .all()
            .into_iter()
            .filter(|(_, session)| session.workspace == workspace)
            .filter_map(|(name, session)| {
                let journal = session.journal.lock().unwrap();
                let since = journal.since?;
                let value = json!({
                    "session": name,
                    "connection": session.connection.as_str(),
                    "name": session.name,
                    "autoCommit": journal.auto_commit,
                    "since": since,
                    "statements": journal.count,
                    "writes": journal.writes,
                    "log": journal.entries,
                });
                Some(redact_secrets(value, &session.secrets))
            })
            .collect();
        Ok(json!({ "sessions": listed }))
    }
}
