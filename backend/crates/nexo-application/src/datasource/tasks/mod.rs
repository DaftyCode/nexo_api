//! Saved database tasks (DB-31), run here from start to end, the same by hand (`db.task.run`)
//! as by the scheduler of the monitors: each one on sessions of its own, closed at its end,
//! with every rule of the statements. Nobody is there to confirm: what asks for a
//! confirmation runs only if the task authorizes it, option by option, and fails with the
//! reason otherwise. A connection that asks for its password each time cannot run in a task.
mod files;
mod mongo;
mod runs;
mod script;
#[cfg(test)]
mod tests;

use super::rules::classify_all;
use crate::{Application, operations::Operation};
use nexo_domain::{
    Document, DocumentId, DocumentKind, Error, Result, WorkspaceId,
    sql::{Classification, Dialect, StatementKind},
};
use serde_json::{Value, json};
use std::sync::atomic::{AtomicU64, Ordering};

/// Names the sessions of tasks, never the same twice.
static SESSIONS: AtomicU64 = AtomicU64::new(0);

/// What a run of a task did so far, for its history.
#[derive(Default)]
pub(crate) struct Report {
    pub statements: u64,
    pub rows: u64,
    pub differences: u64,
    /// The statement that failed, cut short.
    pub statement: Option<String>,
}

/// What a task authorizes, as the person ticked it.
pub(crate) struct Authorized(Value);
impl Authorized {
    fn of(task: &Value) -> Self {
        Self(task["authorize"].clone())
    }
    fn allows(&self, what: &str) -> bool {
        self.0[what] == true
    }
}

impl Application {
    /// `db.task.run`: runs a task now and answers its run, as its history keeps it.
    pub(crate) async fn run_task(&self, payload: &Value) -> Result<Value> {
        let workspace = WorkspaceId::parse(payload["workspace"].as_str().unwrap_or_default())?;
        let id = DocumentId::parse(payload["id"].as_str().unwrap_or_default())?;
        let document = self.workspaces.document(&id).await?;
        if document.kind != DocumentKind::DbTask || document.workspace_id != workspace {
            return Err(Error::NotFound);
        }
        let now = self.task_clock();
        if !self.monitors.begin(id.as_str(), now) {
            return Err(Error::Validation(
                "This task is still running; it can run again when it finishes".into(),
            ));
        }
        let entry = self.task_run(&document, "manual", now).await;
        let kept = self.record_run(&document, entry.clone()).await;
        self.monitors.end(id.as_str());
        kept?;
        Ok(entry)
    }

    /// The time now, from the scheduler's clock when it runs.
    pub(crate) fn task_clock(&self) -> i64 {
        self.monitors.scheduler().map_or_else(
            |_| {
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map_or(0, |d| d.as_millis() as i64)
            },
            |(_, clock)| clock.now(),
        )
    }

    /// Opens a session of its own on a saved connection, as the task's.
    async fn task_session(&self, workspace: &WorkspaceId, connection: &str) -> Result<String> {
        let session = format!("task-{}", SESSIONS.fetch_add(1, Ordering::Relaxed) + 1);
        let opened = self
            .datasource(
                Operation::DbConnect,
                json!({"workspace": workspace.as_str(), "connectionId": connection, "session": session}),
            )
            .await;
        match opened {
            Ok(_) => Ok(session),
            Err(Error::Database { code, .. }) if code == "password" => Err(Error::Validation(
                "The connection asks for its password each time: a task cannot type it".into(),
            )),
            Err(error) => Err(error),
        }
    }
    async fn close_session(&self, session: &str) {
        let _ = self
            .datasource(Operation::DbDisconnect, json!({"session": session}))
            .await;
    }

    /// The confirmations a statement asks on a session, checked against what the task
    /// authorizes: what to send with it, or why it cannot run.
    fn authorize(
        &self,
        session: &str,
        sql: &str,
        authorized: &Authorized,
    ) -> Result<(bool, Option<String>)> {
        let open = self.sql_sessions.get(session)?;
        let classification: Classification = classify_all(sql, Dialect::parse(&open.driver));
        let mut asked = Vec::new();
        if classification.drops {
            asked.push(("drop", "a DROP"));
        }
        if classification.missing_where || classification.truncate {
            asked.push(("everyRow", "statements on every row of a table"));
        }
        if (open.rules.confirm_writes && classification.writes())
            || (open.rules.confirm_structure && classification.kind == StatementKind::Structure)
        {
            asked.push((
                "writes",
                "changes on a connection that asks to confirm each one",
            ));
        }
        if let Some((_, what)) = asked.iter().find(|(key, _)| !authorized.allows(key)) {
            return Err(Error::Validation(format!(
                "The task does not authorize {what}"
            )));
        }
        let name = classification.drops.then(|| classification.drop.join(", "));
        Ok((!asked.is_empty(), name.filter(|name| !name.is_empty())))
    }

    /// A run of a task, as its history keeps it: when, how long, its state and what it did.
    pub(crate) async fn task_run(&self, task: &Document, trigger: &str, started: i64) -> Value {
        let mut report = Report::default();
        let outcome = Box::pin(self.task_steps(task, &mut report, 0)).await;
        let duration = (self.task_clock() - started).max(0);
        let state = match &outcome {
            Err(_) => "failed",
            Ok(()) if report.differences > 0 => "differences",
            Ok(()) => "passed",
        };
        let mut entry = json!({
            "startedAt": started,
            "duration": duration,
            "trigger": trigger,
            "state": state,
            "statements": report.statements,
            "rows": report.rows,
        });
        if matches!(
            task.value["type"].as_str(),
            Some("compare" | "mongo-compare")
        ) {
            entry["differences"] = json!(report.differences);
        }
        if let Err(error) = outcome {
            entry["error"] = json!(error.to_string());
            if let Some(statement) = report.statement {
                entry["statement"] = json!(statement);
            }
        }
        entry
    }
}
