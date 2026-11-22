//! MongoDB in tasks (DB-40): a saved transfer (a copy to another collection, an export to a
//! file, an import of JSON) and a saved comparison, whose differences the run says and which
//! syncs the target only when the task authorizes it. They read with the query the transfer
//! or comparison kept compiled when it was saved (`built`, `builtFilter`).
mod compare;
mod file;

use super::{Authorized, Report};
use crate::{Application, database::saved_connection, operations::Operation};
use nexo_domain::{
    Document, DocumentId, DocumentKind, Error, Result, WorkspaceId,
    transfer_file::{FileFormat, dated},
};
use serde_json::{Map, Value, json};

/// Documents read and written at once.
const BATCH: u64 = 1_000;

fn invalid(message: impl Into<String>) -> Error {
    Error::Validation(message.into())
}

impl Application {
    /// A saved document of the workspace, of the kind a task names.
    async fn saved(
        &self,
        workspace: &WorkspaceId,
        id: &Value,
        kind: DocumentKind,
    ) -> Result<Document> {
        let id = DocumentId::parse(id.as_str().unwrap_or_default())?;
        let document = self.workspaces.document(&id).await.ok();
        document
            .filter(|document| document.kind == kind && &document.workspace_id == workspace)
            .ok_or_else(|| {
                invalid(format!(
                    "The saved {} of the task no longer exists",
                    kind.as_str()
                ))
            })
    }

    /// One side of a transfer or comparison: its saved MongoDB connection, database and
    /// collection, as the operations take them.
    async fn mongo_side(&self, workspace: &WorkspaceId, side: &Value) -> Result<(Document, Value)> {
        let connection = self
            .saved(workspace, &side["connection"], DocumentKind::Connection)
            .await?;
        let place = json!({
            "workspace": workspace.as_str(),
            "connection": saved_connection(&connection.value, &Map::new()),
            "database": side["database"],
            "collection": side["collection"],
        });
        Ok((connection, place))
    }

    /// `mongo-transfer`: runs a saved transfer.
    pub(super) async fn run_mongo_transfer(
        &self,
        workspace: &WorkspaceId,
        task: &Value,
        report: &mut Report,
    ) -> Result<()> {
        let saved = self
            .saved(workspace, &task["transfer"], DocumentKind::Transfer)
            .await?;
        let value = &saved.value;
        let (_, source) = self.mongo_side(workspace, value).await?;
        let to_file = value["destination"] != "collection";
        if value["direction"] == "import" {
            return self
                .mongo_import_file(workspace, task, value, source, report)
                .await;
        }
        if !value["built"].is_object() {
            return Err(invalid(
                "Open the saved transfer and save it again: a task runs the query it keeps",
            ));
        }
        let mut written = 0_u64;
        let mut target = None;
        let mut file = None;
        if to_file {
            let format =
                FileFormat::parse(value["format"].as_str().unwrap_or_default()).map_err(|_| {
                    invalid("A task writes MongoDB documents as JSON, JSON Lines or CSV")
                })?;
            let path = dated(task["file"].as_str().unwrap_or_default(), self.task_clock());
            if path.is_empty() {
                return Err(invalid("Write the file the task exports to"));
            }
            let path = self
                .task_files()?
                .create(&path, task["overwrite"] == true)
                .await?;
            file = Some((format, path));
        } else {
            target = Some(self.mongo_side(workspace, &value["to"]).await?);
        }
        let (first_page, id) = self.mongo_first_page(&source, &value["built"]).await?;
        let mut page = first_page;
        let outcome = async {
            if let Some((format, path)) = &file {
                self.task_files()?.append(path, self.file_opening(*format, value).into_bytes()).await?;
            }
            loop {
                let mut documents = page["documents"].as_array().cloned().unwrap_or_default();
                if let Some(mask) = value["mask"].as_str().filter(|mask| !mask.is_empty()) {
                    documents = self.masked(workspace, mask, documents).await?;
                }
                if let Some((format, path)) = &file {
                    let text = self.file_part(*format, value, &documents, written == 0);
                    self.task_files()?.append(path, text.into_bytes()).await?;
                } else if let Some((connection, place)) = &target {
                    self.mongo_write(task, value, connection, place, &documents, written == 0, report)
                        .await?;
                }
                written += documents.len() as u64;
                let Some(cursor) = page["cursor"].as_str().map(str::to_owned) else {
                    break;
                };
                page = self
                    .execute(
                        Operation::MongoMore,
                        json!({"workspace": workspace.as_str(), "cursor": cursor, "id": id, "pageSize": BATCH}),
                    )
                    .await?;
            }
            if let Some((format, path)) = &file {
                let closing = if *format == FileFormat::Json { "\n]\n" } else { "" };
                self.task_files()?.append(path, closing.as_bytes().to_vec()).await?;
            }
            Ok(())
        }
        .await;
        if let Some(cursor) = page["cursor"].as_str() {
            let _ = self
                .execute(
                    Operation::MongoClose,
                    json!({"workspace": workspace.as_str(), "cursor": cursor}),
                )
                .await;
        }
        report.statements += 1;
        if file.is_some() {
            report.rows += written;
        }
        outcome
    }

    async fn mongo_first_page(&self, source: &Value, built: &Value) -> Result<(Value, String)> {
        let id = format!("task-{}", uuid::Uuid::new_v4().simple());
        let mut payload = source.clone();
        payload["id"] = json!(id);
        payload["pageSize"] = json!(BATCH);
        let operation = if let Some(pipeline) = built["pipeline"].as_object() {
            payload["pipeline"] = pipeline.get("pipeline").cloned().unwrap_or(json!([]));
            for (key, option) in pipeline
                .get("options")
                .and_then(Value::as_object)
                .into_iter()
                .flatten()
            {
                payload[key] = option.clone();
            }
            Operation::MongoAggregate
        } else {
            for (key, part) in built["query"].as_object().into_iter().flatten() {
                payload[key] = part.clone();
            }
            Operation::MongoFind
        };
        Ok((self.execute(operation, payload).await?, id))
    }

    /// A batch written into the target collection, as the transfer says.
    #[allow(clippy::too_many_arguments)]
    async fn mongo_write(
        &self,
        task: &Value,
        value: &Value,
        connection: &Document,
        place: &Value,
        documents: &[Value],
        first: bool,
        report: &mut Report,
    ) -> Result<()> {
        if documents.is_empty() {
            return Ok(());
        }
        let mode = value["mode"].as_str().unwrap_or("insert");
        let mut payload = place.clone();
        payload["connectionId"] = json!(connection.id.as_str());
        payload["documents"] = json!(documents);
        payload["mode"] = json!(if mode == "upsert" { "upsert" } else { "insert" });
        payload["ordered"] = json!(value["continueOnError"] != true);
        if mode == "upsert" {
            payload["key"] = value["key"].clone();
        }
        if mode == "replace" && first {
            if !Authorized::of(task).allows("everyRow") {
                return Err(invalid(format!(
                    "The task does not authorize emptying {} before it writes",
                    place["collection"].as_str().unwrap_or_default()
                )));
            }
            payload["clearConfirm"] = place["collection"].clone();
        }
        let answer = self.execute(Operation::MongoImport, payload).await?;
        report.rows += ["inserted", "upserted", "replaced"]
            .iter()
            .map(|key| answer[key].as_u64().unwrap_or(0))
            .sum::<u64>();
        match answer["failed"]
            .as_array()
            .and_then(|failed| failed.first())
        {
            Some(failure) if value["continueOnError"] != true => Err(invalid(format!(
                "A document was refused: {}",
                failure["message"].as_str().unwrap_or_default()
            ))),
            _ => Ok(()),
        }
    }

    /// Documents through a masking set of the workspace.
    async fn masked(
        &self,
        workspace: &WorkspaceId,
        set: &str,
        documents: Vec<Value>,
    ) -> Result<Vec<Value>> {
        let set = self
            .saved(workspace, &json!(set), DocumentKind::Masking)
            .await?;
        let masked = self
            .executor
            .execute(
                Operation::MaskApply,
                json!({"workspace": workspace.as_str(), "rules": set.value["rules"], "documents": documents}),
            )
            .await?;
        Ok(masked["documents"].as_array().cloned().unwrap_or_default())
    }
}
