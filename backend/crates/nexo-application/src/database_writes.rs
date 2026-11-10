//! Writes to a document database. The rules that keep them safe live here, not in the
//! interface: a read-only connection refuses every write, the connection sent must be the
//! saved one, writes to many documents need the count the person confirmed, and dropping or
//! emptying needs the name repeated. Each write of documents is recorded with the documents
//! before and after it, to undo it.
use crate::{
    Application,
    operations::Operation,
    payloads::{self, MongoConnection},
    ports::{CollectionChange, DocumentChange, DocumentWrite, WriteResult, WriteTarget},
};
use nexo_domain::{Document, DocumentId, DocumentKind, Error, Result, WorkspaceId};
use serde_json::{Map, Value, json};

/// Database changes kept per workspace; older ones are deleted when a new one is saved.
pub const CHANGE_LIMIT: usize = 50;
/// Documents of a change kept to undo it, at most; larger changes are recorded without them.
const CHANGE_BYTES: usize = 64 * 1024;

fn read<T: serde::de::DeserializeOwned>(payload: &Value) -> Result<T> {
    serde_json::from_value(payload.clone()).map_err(|error| Error::Validation(error.to_string()))
}

/// Whether `text` is `template` with each `{{…}}` replaced by some text, as the interface
/// replaces environment variables.
pub fn matches_template(template: &str, text: &str) -> bool {
    let mut literals = Vec::new();
    let mut rest = template;
    while let Some(start) = rest.find("{{") {
        let Some(end) = rest[start..].find("}}") else {
            break;
        };
        literals.push(&rest[..start]);
        rest = &rest[start + end + 2..];
    }
    literals.push(rest);
    if literals.len() == 1 {
        return template == text;
    }
    let (first, last) = (literals[0], literals[literals.len() - 1]);
    if !text.starts_with(first) || !text[first.len()..].ends_with(last) {
        return false;
    }
    let mut middle = &text[first.len()..text.len() - last.len()];
    for literal in &literals[1..literals.len() - 1] {
        match middle.find(literal) {
            Some(index) => middle = &middle[index + literal.len()..],
            None => return false,
        }
    }
    true
}

/// Refuses a connection that is not the saved one: its URI and certificates may only differ
/// by the variables they name, and its secrets must be the saved references.
fn check_same(stored: &Value, sent: &MongoConnection) -> Result<()> {
    let field = |name: &str| {
        stored
            .get(name)
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|text| !text.is_empty())
    };
    let same_template = |name: &str, sent: Option<&String>| match (field(name), sent) {
        (None, None) => true,
        (Some(template), Some(text)) => matches_template(template, text.trim()),
        _ => false,
    };
    let same_secret =
        |name: &str, sent: Option<&String>| field(name) == sent.map(|text| text.trim());
    if same_template("uri", Some(&sent.uri))
        && same_template("caPem", sent.ca_pem.as_ref())
        && same_template("certPem", sent.cert_pem.as_ref())
        && same_secret("password", sent.password.as_ref())
        && same_secret("keyPem", sent.key_pem.as_ref())
    {
        Ok(())
    } else {
        Err(Error::Validation(
            "The connection sent is not the saved one: save it before writing".into(),
        ))
    }
}

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
fn expected(many: bool, expected: Option<u64>) -> Result<Option<u64>> {
    if many && expected.is_none() {
        return Err(Error::Validation(
            "Count the documents first: a write to many documents needs the number confirmed"
                .into(),
        ));
    }
    Ok(expected.filter(|_| many))
}

fn confirmed(confirm: Option<&str>, name: &str, what: &str) -> Result<()> {
    if confirm.map(str::trim) != Some(name) {
        return Err(Error::Validation(format!(
            "Type the name of the {what} to confirm: {name}"
        )));
    }
    Ok(())
}

impl Application {
    /// Runs a write on a saved connection that is not read-only.
    pub(crate) async fn database_write(
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

    async fn collection_change(
        &self,
        operation: Operation,
        payload: &Value,
        connection: crate::ports::DatabaseConnection,
    ) -> Result<Value> {
        let change = match operation {
            Operation::MongoCollectionCreate => {
                let p: payloads::MongoCollectionCreatePayload = read(payload)?;
                CollectionChange::Create {
                    database: p.database,
                    collection: p.collection,
                    options: p.options.map(Value::Object),
                }
            }
            Operation::MongoCollectionRename => {
                let p: payloads::MongoCollectionRenamePayload = read(payload)?;
                CollectionChange::Rename {
                    database: p.database,
                    collection: p.collection,
                    to: p.to,
                }
            }
            Operation::MongoCollectionDrop => {
                let p: payloads::MongoCollectionDropPayload = read(payload)?;
                confirmed(Some(&p.confirm), &p.collection, "collection")?;
                CollectionChange::Drop {
                    database: p.database,
                    collection: p.collection,
                }
            }
            Operation::MongoDatabaseDrop => {
                let p: payloads::MongoDatabaseDropPayload = read(payload)?;
                confirmed(Some(&p.confirm), &p.database, "database")?;
                CollectionChange::DropDatabase {
                    database: p.database,
                }
            }
            _ => return Err(Error::Validation("Unknown database operation".into())),
        };
        self.database.change(connection, change).await?;
        Ok(json!({ "done": true }))
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_connection_may_differ_only_by_its_variables() {
        assert!(matches_template("mongodb://h", "mongodb://h"));
        assert!(!matches_template("mongodb://h", "mongodb://other"));
        assert!(matches_template(
            "mongodb://{{host}}:27017/{{db}}?tls=true",
            "mongodb://db.test:27017/shop?tls=true"
        ));
        assert!(!matches_template(
            "mongodb://{{host}}:27017/?tls=true",
            "mongodb://db.test:27018/?tls=true"
        ));
        assert!(!matches_template("mongodb://{{host}}/x", "mongodb://a/y"));
        let stored = json!({"uri": "mongodb://ana@{{host}}", "password": "{{vault:p}}"});
        let sent = |uri: &str, password: Option<&str>| MongoConnection {
            uri: uri.into(),
            password: password.map(String::from),
            ..Default::default()
        };
        assert!(check_same(&stored, &sent("mongodb://ana@db.test", Some("{{vault:p}}"))).is_ok());
        assert!(check_same(&stored, &sent("mongodb://ana@db.test", Some("typed"))).is_err());
        assert!(
            check_same(
                &stored,
                &sent("mongodb://root@db.test", Some("{{vault:p}}"))
            )
            .is_err()
        );
        assert!(check_same(&stored, &sent("mongodb://ana@db.test", None)).is_err());
    }

    #[test]
    fn many_documents_need_their_count_and_everything_needs_the_name() {
        assert!(expected(true, None).is_err());
        assert_eq!(expected(true, Some(3)).unwrap(), Some(3));
        assert_eq!(expected(false, Some(3)).unwrap(), None);
        assert!(confirmed(Some(" orders "), "orders", "collection").is_ok());
        assert_eq!(
            confirmed(Some("order"), "orders", "collection")
                .unwrap_err()
                .to_string(),
            "Type the name of the collection to confirm: orders"
        );
        assert!(confirmed(None, "shop", "database").is_err());
    }
}
