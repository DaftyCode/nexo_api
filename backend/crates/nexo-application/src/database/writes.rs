//! Writes to a document database. The rules that keep them safe live here, not in the
//! interface: a read-only connection refuses every write, the connection sent must be the
//! saved one, writes to many documents need the count the person confirmed, and dropping or
//! emptying needs the name repeated. Each write of documents is recorded with the documents
//! before and after it, to undo it.
use super::{confirmed, connection::check_same, read};
use crate::{
    Application,
    operations::Operation,
    payloads::{self, MongoConnection},
    ports::{DocumentChange, DocumentWrite, WriteResult, WriteTarget},
};
use nexo_domain::{Document, DocumentId, DocumentKind, Error, Result, WorkspaceId};
use serde_json::{Map, Value, json};

/// Database changes kept per workspace; older ones are deleted when a new one is saved.
pub const CHANGE_LIMIT: usize = 50;
/// Documents of a change kept to undo it, at most; larger changes are recorded without them.
const CHANGE_BYTES: usize = 64 * 1024;

fn target(
    database: String,
    collection: String,
    concern: Option<Map<String, Value>>,
) -> WriteTarget {
    WriteTarget {
        database,
        collection,
        write_concern: concern.map(Value::Object),
    }
}

/// A write to many documents needs the number the person confirmed.
pub(super) fn expected(many: bool, expected: Option<u64>) -> Result<Option<u64>> {
    if many && expected.is_none() {
        return Err(Error::Validation(
            "Count the documents first: a write to many documents needs the number confirmed"
                .into(),
        ));
    }
    Ok(expected.filter(|_| many))
}

impl Application {
    /// Runs a write on a saved connection that is not read-only.
    pub(super) async fn database_write(
        &self,
        operation: Operation,
        payload: Value,
        values: &mut Vec<(String, String)>,
    ) -> Result<Value> {
        let workspace = WorkspaceId::parse(payload["workspace"].as_str().unwrap_or_default())?;
        let id = DocumentId::parse(payload["connectionId"].as_str().unwrap_or_default())?;
        let stored = self.workspaces.document(&id).await?;
        if stored.kind != DocumentKind::Connection || stored.workspace_id != workspace {
            return Err(Error::Validation(
                "Choose a saved connection of this workspace".into(),
            ));
        }
        if stored.value.get("readOnly") == Some(&Value::Bool(true)) {
            return Err(Error::Validation(format!(
                "The connection {} is read-only: Nexo refuses its writes",
                stored.name
            )));
        }
        let sent: MongoConnection = read(&payload["connection"])?;
        check_same(&stored.value, &sent)?;
        let connection = self.resolve_connection(sent, values).await?;
        let database = &self.database;
        let (target, result) = match operation {
            Operation::MongoInsert => {
                let p: payloads::MongoInsertPayload = read(&payload)?;
                if p.documents.is_empty() {
                    return Err(Error::Validation("Add at least one document".into()));
                }
                let target = target(p.database, p.collection, p.write_concern);
                let documents = p.documents.into_iter().map(Value::Object).collect();
                let write = DocumentWrite::Insert { documents };
                (
                    target.clone(),
                    database.write(connection, target, write).await?,
                )
            }
            Operation::MongoUpdate => {
                let p: payloads::MongoUpdatePayload = read(&payload)?;
                let many = p.many.unwrap_or(false);
                let write = DocumentWrite::Update {
                    filter: Value::Object(p.filter),
                    update: p.update,
                    many,
                    expected: expected(many, p.expected)?,
                };
                let target = target(p.database, p.collection, p.write_concern);
                (
                    target.clone(),
                    database.write(connection, target, write).await?,
                )
            }
            Operation::MongoReplace => {
                let p: payloads::MongoReplacePayload = read(&payload)?;
                let write = DocumentWrite::Replace {
                    filter: Value::Object(p.filter),
                    replacement: Value::Object(p.replacement),
                };
                let target = target(p.database, p.collection, p.write_concern);
                (
                    target.clone(),
                    database.write(connection, target, write).await?,
                )
            }
            Operation::MongoDelete => {
                let p: payloads::MongoDeletePayload = read(&payload)?;
                let many = p.many.unwrap_or(false);
                if many && p.filter.is_empty() {
                    confirmed(p.confirm.as_deref(), &p.collection, "collection")?;
                }
                let write = DocumentWrite::Delete {
                    filter: Value::Object(p.filter),
                    many,
                    expected: expected(many, p.expected)?,
                };
                let target = target(p.database, p.collection, p.write_concern);
                (
                    target.clone(),
                    database.write(connection, target, write).await?,
                )
            }
            Operation::MongoUndo => {
                let p: payloads::MongoUndoPayload = read(&payload)?;
                let change = self
                    .workspaces
                    .document(&DocumentId::parse(p.change)?)
                    .await?;
                if change.kind != DocumentKind::DatabaseChange
                    || change.workspace_id != workspace
                    || change.value["connection"] != Value::String(id.to_string())
                {
                    return Err(Error::Validation(
                        "That change is not one of this connection".into(),
                    ));
                }
                let changes: Vec<DocumentChange> =
                    serde_json::from_value(change.value["changes"].clone()).unwrap_or_default();
                if changes.is_empty() {
                    return Err(Error::Validation(
                        "This change cannot be undone: it was too large to record, or changed many documents".into(),
                    ));
                }
                let target = target(
                    change.value["database"].as_str().unwrap_or_default().into(),
                    change.value["collection"]
                        .as_str()
                        .unwrap_or_default()
                        .into(),
                    None,
                );
                let write = DocumentWrite::Restore { changes };
                (
                    target.clone(),
                    database.write(connection, target, write).await?,
                )
            }
            Operation::MongoImport => return self.import_batch(&payload, connection).await,
            Operation::MongoSync => return self.sync(&payload, connection, values).await,
            Operation::MongoAggregateWrite => {
                return self.aggregate_write(&payload, connection).await;
            }
            _ => {
                return self
                    .collection_change(operation, &payload, connection)
                    .await;
            }
        };
        let change = self
            .record_change(&workspace, &id, operation, &target, &result)
            .await?;
        let mut answer = serde_json::to_value(&result)
            .map_err(|error| Error::Infrastructure(error.to_string()))?;
        answer["change"] = Value::String(change);
        Ok(answer)
    }

    /// Records a write with its documents, while they are small enough to keep.
    async fn record_change(
        &self,
        workspace: &WorkspaceId,
        connection: &DocumentId,
        operation: Operation,
        target: &WriteTarget,
        result: &WriteResult,
    ) -> Result<String> {
        let changes = serde_json::to_value(&result.changes)
            .map_err(|error| Error::Infrastructure(error.to_string()))?;
        let kept = !result.changes.is_empty() && changes.to_string().len() <= CHANGE_BYTES;
        let id = uuid::Uuid::new_v4().to_string();
        let value = json!({
            "connection": connection.as_str(),
            "database": target.database,
            "collection": target.collection,
            "operation": operation.as_str(),
            "matched": result.matched,
            "modified": result.modified,
            "deleted": result.deleted,
            "inserted": result.inserted.len(),
            "changes": if kept { changes } else { Value::Array(Vec::new()) },
        });
        let document = Document {
            id: DocumentId::parse(id.clone())?,
            workspace_id: workspace.clone(),
            kind: DocumentKind::DatabaseChange,
            name: format!(
                "{} {}.{}",
                operation.as_str(),
                target.database,
                target.collection
            ),
            revision: 0,
            updated_at: 0,
            value,
        };
        self.save_document(document).await?;
        Ok(id)
    }
}
