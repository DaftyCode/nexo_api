//! What each kind of task does: a copy of a query into a table of another connection, page
//! by page; a comparison of two schemas or tables, whose differences make the run say so; a
//! backup with the local client, followed until it ends; and other tasks, in order.
use super::{Authorized, Report};
use crate::{Application, operations::Operation};
use nexo_domain::{Document, DocumentId, DocumentKind, Error, Result, WorkspaceId};
use serde_json::{Map, Value, json};
use std::time::Duration;

/// Tasks inside tasks, at most: a composite that names itself stops there.
const DEPTH: usize = 4;

impl Application {
    pub(super) async fn task_steps(
        &self,
        task: &Document,
        report: &mut Report,
        depth: usize,
    ) -> Result<()> {
        let workspace = &task.workspace_id;
        let value = &task.value;
        match value["type"].as_str().unwrap_or_default() {
            "script" => self.run_scripts(workspace, value, report).await,
            "copy" => self.run_copy(workspace, value, report).await,
            "compare" => self.run_compare(workspace, value, report).await,
            "backup" => self.run_backup(workspace, value).await,
            "export" => self.run_export(workspace, value, report).await,
            "import" => self.run_import(workspace, value, report).await,
            "mongo-transfer" => self.run_mongo_transfer(workspace, value, report).await,
            "mongo-compare" => self.run_mongo_compare(workspace, value, report).await,
            "composite" => {
                if depth >= DEPTH {
                    return Err(Error::Validation(
                        "The tasks inside this task go too deep".into(),
                    ));
                }
                let go_on = value["onError"] == "continue";
                let mut failure = None;
                for id in value["tasks"].as_array().into_iter().flatten() {
                    let id = DocumentId::parse(id.as_str().unwrap_or_default())?;
                    let step = self.workspaces.document(&id).await?;
                    if step.kind != DocumentKind::DbTask || &step.workspace_id != workspace {
                        return Err(Error::Validation(
                            "A task of this one no longer exists".into(),
                        ));
                    }
                    if let Err(error) = Box::pin(self.task_steps(&step, report, depth + 1)).await {
                        let error = Error::Validation(format!("{}: {error}", step.name));
                        if !go_on {
                            return Err(error);
                        }
                        failure.get_or_insert(error);
                    }
                }
                failure.map_or(Ok(()), Err)
            }
            other => Err(Error::Validation(format!("Unknown task {other}"))),
        }
    }

    async fn run_copy(
        &self,
        workspace: &WorkspaceId,
        task: &Value,
        report: &mut Report,
    ) -> Result<()> {
        let source = self
            .task_session(workspace, task["source"].as_str().unwrap_or_default())
            .await?;
        let target = match self
            .task_session(workspace, task["target"].as_str().unwrap_or_default())
            .await
        {
            Ok(target) => target,
            Err(error) => {
                self.close_session(&source).await;
                return Err(error);
            }
        };
        let confirm = Authorized::of(task).allows("writes");
        let outcome = async {
            let mut page = json!({
                "source": source,
                "target": target,
                "table": task["table"],
                "sql": task["sql"],
                "mode": task["mode"].as_str().unwrap_or("insert"),
                "confirm": confirm,
            });
            if let Some(schema) = task["schema"].as_str().filter(|s| !s.is_empty()) {
                page["schema"] = json!(schema);
            }
            let mut first = 1_u64;
            loop {
                let answer = self.datasource(Operation::DbCopy, page.clone()).await?;
                let read = answer["read"].as_u64().unwrap_or(0);
                report.rows += answer["inserted"].as_u64().unwrap_or(0)
                    + answer["upserted"].as_u64().unwrap_or(0);
                report.statements += 1;
                if answer["failed"].as_u64().unwrap_or(0) > 0 {
                    return Err(Error::Validation(format!(
                        "{} rows were refused by the target",
                        answer["failed"]
                    )));
                }
                let Some(cursor) = answer["cursor"].as_str() else {
                    return Ok(());
                };
                first += read;
                if let Some(columns) = answer["columns"].as_array() {
                    let names: Vec<Value> = columns
                        .iter()
                        .map(|column| {
                            column
                                .get("name")
                                .cloned()
                                .unwrap_or_else(|| column.clone())
                        })
                        .collect();
                    page["columns"] = Value::Array(names);
                }
                page["cursor"] = json!(cursor);
                page["first"] = json!(first);
                page.as_object_mut().map(|page| page.remove("sql"));
            }
        }
        .await;
        self.close_session(&source).await;
        self.close_session(&target).await;
        outcome
    }

    async fn run_compare(
        &self,
        workspace: &WorkspaceId,
        task: &Value,
        report: &mut Report,
    ) -> Result<()> {
        let source = self
            .task_session(
                workspace,
                task["source"]["connection"].as_str().unwrap_or_default(),
            )
            .await?;
        let target = match self
            .task_session(
                workspace,
                task["target"]["connection"].as_str().unwrap_or_default(),
            )
            .await
        {
            Ok(target) => target,
            Err(error) => {
                self.close_session(&source).await;
                return Err(error);
            }
        };
        let side = |side: &Value, session: &str| {
            let mut side = side.clone();
            side.as_object_mut().map(|side| side.remove("connection"));
            side["session"] = json!(session);
            side
        };
        let mut payload = task["options"].as_object().cloned().unwrap_or_default();
        payload.insert("source".into(), side(&task["source"], &source));
        payload.insert("target".into(), side(&task["target"], &target));
        let operation = if task["mode"] == "data" {
            Operation::DbCompareData
        } else {
            Operation::DbCompareSchema
        };
        let outcome = self.datasource(operation, Value::Object(payload)).await;
        self.close_session(&source).await;
        self.close_session(&target).await;
        let counts = &outcome?["counts"];
        report.differences = ["onlySource", "onlyTarget", "different"]
            .iter()
            .map(|field| counts[field].as_u64().unwrap_or(0))
            .sum();
        report.rows = counts["equal"].as_u64().unwrap_or(0) + report.differences;
        Ok(())
    }

    /// A backup with the local client (the desktop app), followed until its tool ends.
    async fn run_backup(&self, workspace: &WorkspaceId, task: &Value) -> Result<()> {
        let mut options = task["options"].as_object().cloned().unwrap_or_default();
        options.insert("path".into(), task["file"].clone());
        let mut payload = Map::new();
        payload.insert("workspace".into(), json!(workspace.as_str()));
        payload.insert("connection".into(), task["connection"].clone());
        payload.insert("options".into(), Value::Object(options));
        let started = self.native(Operation::NativeBackup, payload).await?;
        let id = started["id"].as_str().unwrap_or_default().to_owned();
        loop {
            let mut asked = Map::new();
            asked.insert("id".into(), json!(id));
            let status = self.native(Operation::NativeStatus, asked).await?;
            match status["state"].as_str() {
                Some("running") => tokio::time::sleep(Duration::from_millis(500)).await,
                Some("finished") => return Ok(()),
                _ => {
                    let lines = status["lines"].as_array().map(|lines| {
                        lines
                            .iter()
                            .rev()
                            .take(3)
                            .filter_map(Value::as_str)
                            .collect::<Vec<_>>()
                            .join(" / ")
                    });
                    return Err(Error::Validation(format!(
                        "The backup failed{}",
                        lines.map(|l| format!(": {l}")).unwrap_or_default()
                    )));
                }
            }
        }
    }
}
