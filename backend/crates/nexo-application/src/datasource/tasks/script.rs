//! A task of scripts: each saved script on each connection, split into its statements and run
//! one at a time with every rule, its rows counted and its results closed; in a transaction
//! of its own when the task asks, undone at the first failure.
use super::{Authorized, Report};
use crate::{Application, operations::Operation};
use nexo_domain::{
    DocumentId, DocumentKind, Error, Result, WorkspaceId,
    sql::{Dialect, split},
};
use serde_json::{Value, json};

/// A statement as the history keeps it, cut short.
pub(super) fn short(sql: &str) -> String {
    let text = sql.trim();
    match text.char_indices().nth(200) {
        Some((at, _)) => format!("{}…", &text[..at]),
        None => text.to_owned(),
    }
}

impl Application {
    pub(super) async fn run_scripts(
        &self,
        workspace: &WorkspaceId,
        task: &Value,
        report: &mut Report,
    ) -> Result<()> {
        let authorized = Authorized::of(task);
        let go_on = task["onError"] == "continue";
        let mut failure = None;
        for script in task["scripts"].as_array().into_iter().flatten() {
            let id = DocumentId::parse(script.as_str().unwrap_or_default())?;
            let document = self.workspaces.document(&id).await?;
            if document.kind != DocumentKind::SqlScript || &document.workspace_id != workspace {
                return Err(Error::Validation(
                    "A script of the task no longer exists".into(),
                ));
            }
            let sql = document.value["sql"]
                .as_str()
                .unwrap_or_default()
                .to_owned();
            for connection in task["connections"].as_array().into_iter().flatten() {
                let connection = connection.as_str().unwrap_or_default();
                let outcome = self
                    .run_script(workspace, connection, &sql, task, &authorized, report)
                    .await;
                if let Err(error) = outcome {
                    if !go_on {
                        return Err(error);
                    }
                    failure.get_or_insert(error);
                }
            }
        }
        failure.map_or(Ok(()), Err)
    }

    async fn run_script(
        &self,
        workspace: &WorkspaceId,
        connection: &str,
        sql: &str,
        task: &Value,
        authorized: &Authorized,
        report: &mut Report,
    ) -> Result<()> {
        let session = self.task_session(workspace, connection).await?;
        let transaction = task["transaction"] == true;
        let outcome = async {
            if transaction {
                self.datasource(
                    Operation::DbTransaction,
                    json!({"session": session, "action": "manual"}),
                )
                .await?;
            }
            let driver = self.sql_sessions.get(&session)?.driver.clone();
            for (at, statement) in split(sql, Dialect::parse(&driver)).into_iter().enumerate() {
                report.statement = Some(short(&statement.text));
                let (confirm, confirm_name) =
                    self.authorize(&session, &statement.text, authorized)?;
                let answer = self
                    .datasource(
                        Operation::DbExecute,
                        json!({
                            "session": session,
                            "statement": format!("{session}-{at}"),
                            "sql": statement.text,
                            "confirm": confirm,
                            "confirmName": confirm_name,
                        }),
                    )
                    .await?;
                report.statements += 1;
                report.rows += answer["rows"].as_array().map_or(0, Vec::len) as u64
                    + answer["affected"].as_u64().unwrap_or(0);
                if let Some(cursor) = answer["cursor"].as_str() {
                    let _ = self
                        .datasource(
                            Operation::DbClose,
                            json!({"session": session, "cursor": cursor}),
                        )
                        .await;
                }
            }
            report.statement = None;
            if transaction {
                self.datasource(
                    Operation::DbTransaction,
                    json!({"session": session, "action": "commit"}),
                )
                .await?;
            }
            Ok::<(), Error>(())
        }
        .await;
        if outcome.is_err() && transaction {
            let _ = self
                .datasource(
                    Operation::DbTransaction,
                    json!({"session": session, "action": "rollback"}),
                )
                .await;
        }
        self.close_session(&session).await;
        outcome
    }
}
