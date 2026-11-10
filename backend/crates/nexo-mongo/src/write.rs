//! Writes: documents (insert, update, replace, delete and restoring recorded changes) and
//! collections and databases. Single-document writes use `findOneAnd…` so the document
//! before the write is known, and read it again after, to record both for undo.
use crate::{
    browse::check_name,
    errors,
    query::{document, extended_json_document},
};
use bson::{Document, doc, oid::ObjectId};
use mongodb::{
    Client, Collection,
    options::{
        Acknowledgment, CollectionOptions, ReturnDocument, UpdateModifications, WriteConcern,
    },
};
use nexo_application::ports::{
    CollectionChange, DocumentChange, DocumentWrite, WriteResult, WriteTarget,
};
use nexo_domain::{Error, Result};
use serde_json::Value;
use std::time::Duration;

/// Documents of an insert recorded to undo it, at most.
const RECORDED: usize = 100;

/// A write concern from `{w, j, wtimeout}`. Unacknowledged writes are refused: Nexo needs to
/// know what changed.
fn write_concern(value: Option<Value>) -> Result<Option<WriteConcern>> {
    let Some(value) = value else { return Ok(None) };
    let fields = value
        .as_object()
        .ok_or_else(|| Error::Validation("The write concern is a document".into()))?;
    let mut concern = WriteConcern::default();
    match fields.get("w") {
        None | Some(Value::Null) => {}
        Some(Value::Number(number)) => match number.as_u64() {
            Some(0) => {
                return Err(Error::Validation(
                    "Unacknowledged writes (w: 0) are not supported: Nexo needs to know what changed"
                        .into(),
                ));
            }
            Some(nodes) => concern.w = Some(Acknowledgment::Nodes(nodes as u32)),
            None => return Err(Error::Validation("Invalid write concern w".into())),
        },
        Some(Value::String(text)) if text == "majority" => {
            concern.w = Some(Acknowledgment::Majority)
        }
        Some(Value::String(text)) => concern.w = Some(Acknowledgment::Custom(text.clone())),
        Some(_) => return Err(Error::Validation("Invalid write concern w".into())),
    }
    if let Some(journal) = fields.get("j") {
        concern.journal = Some(
            journal
                .as_bool()
                .ok_or_else(|| Error::Validation("Invalid write concern j".into()))?,
        );
    }
    if let Some(timeout) = fields.get("wtimeout") {
        let millis = timeout
            .as_u64()
            .ok_or_else(|| Error::Validation("Invalid write concern wtimeout".into()))?;
        concern.w_timeout = Some(Duration::from_millis(millis));
    }
    Ok(Some(concern))
}

fn required(value: Value, what: &str) -> Result<Document> {
    document(Some(value), what)?
        .ok_or_else(|| Error::Validation(format!("The {what} must be a document")))
}

/// A filter that matches a document only while it is exactly as it was: no field changed,
/// added or removed (`$$ROOT` against the document as a literal).
fn unchanged(document: &Document) -> Result<Document> {
    let mut filter = by_id(document)?;
    filter.insert(
        "$expr",
        doc! {"$eq": ["$$ROOT", {"$literal": document.clone()}]},
    );
    Ok(filter)
}

/// The filter of a document by its `_id`.
fn by_id(document: &Document) -> Result<Document> {
    let id = document
        .get("_id")
        .ok_or_else(|| Error::Validation("The document has no _id".into()))?;
    Ok(doc! {"_id": id.clone()})
}

pub async fn write(
    client: &Client,
    target: WriteTarget,
    write: DocumentWrite,
) -> Result<WriteResult> {
    check_name(&target.database, "database")?;
    check_name(&target.collection, "collection")?;
    let mut options = CollectionOptions::default();
    options.write_concern = write_concern(target.write_concern)?;
    let collection: Collection<Document> = client
        .database(&target.database)
        .collection_with_options(&target.collection, options);
    match write {
        DocumentWrite::Insert { documents } => insert(&collection, documents).await,
        DocumentWrite::Update {
            filter,
            update,
            many,
            expected,
        } => {
            let filter = required(filter, "filter")?;
            let update = match update {
                Value::Array(stages) => UpdateModifications::Pipeline(
                    stages
                        .into_iter()
                        .map(|stage| required(stage, "update"))
                        .collect::<Result<_>>()?,
                ),
                update => UpdateModifications::Document(required(update, "update")?),
            };
            if many {
                check_count(&collection, &filter, expected).await?;
                let result = collection
                    .update_many(filter, update)
                    .await
                    .map_err(errors::driver)?;
                return Ok(WriteResult {
                    matched: result.matched_count,
                    modified: result.modified_count,
                    ..Default::default()
                });
            }
            let before = collection
                .find_one_and_update(filter, update)
                .return_document(ReturnDocument::Before)
                .await
                .map_err(errors::driver)?;
            single(&collection, before, false).await
        }
        DocumentWrite::Replace {
            filter,
            replacement,
        } => {
            let before = collection
                .find_one_and_replace(
                    required(filter, "filter")?,
                    required(replacement, "replacement")?,
                )
                .return_document(ReturnDocument::Before)
                .await
                .map_err(errors::driver)?;
            single(&collection, before, false).await
        }
        DocumentWrite::Delete {
            filter,
            many,
            expected,
        } => {
            let filter = required(filter, "filter")?;
            if many {
                check_count(&collection, &filter, expected).await?;
                let result = collection
                    .delete_many(filter)
                    .await
                    .map_err(errors::driver)?;
                return Ok(WriteResult {
                    deleted: result.deleted_count,
                    ..Default::default()
                });
            }
            let before = collection
                .find_one_and_delete(filter)
                .await
                .map_err(errors::driver)?;
            single(&collection, before, true).await
        }
        DocumentWrite::Restore { changes } => restore(&collection, changes).await,
    }
}

async fn insert(collection: &Collection<Document>, documents: Vec<Value>) -> Result<WriteResult> {
    let mut written = Vec::with_capacity(documents.len());
    for value in documents {
        let mut document = required(value, "document")?;
        // An `_id` chosen here, so the document recorded is the one inserted.
        if !document.contains_key("_id") {
            let mut with_id = doc! {"_id": ObjectId::new()};
            with_id.extend(document);
            document = with_id;
        }
        written.push(document);
    }
    collection
        .insert_many(&written)
        .await
        .map_err(errors::driver)?;
    let inserted = written
        .iter()
        .map(|document| extended_json_document(by_id(document)?).map(|id| id["_id"].clone()))
        .collect::<Result<Vec<_>>>()?;
    let changes = if written.len() <= RECORDED {
        written
            .into_iter()
            .map(|document| {
                Ok(DocumentChange {
                    before: None,
                    after: Some(extended_json_document(document)?),
                })
            })
            .collect::<Result<_>>()?
    } else {
        Vec::new()
    };
    Ok(WriteResult {
        inserted,
        changes,
        ..Default::default()
    })
}

/// The result of a write of one document, with the document before and after it.
async fn single(
    collection: &Collection<Document>,
    before: Option<Document>,
    deleted: bool,
) -> Result<WriteResult> {
    let Some(before) = before else {
        return Ok(WriteResult::default());
    };
    let after = if deleted {
        None
    } else {
        collection
            .find_one(by_id(&before)?)
            .await
            .map_err(errors::driver)?
    };
    let modified = u64::from(after.as_ref() != Some(&before) && !deleted);
    Ok(WriteResult {
        matched: 1,
        modified,
        deleted: u64::from(deleted),
        changes: vec![DocumentChange {
            before: Some(extended_json_document(before)?),
            after: after.map(extended_json_document).transpose()?,
        }],
        ..Default::default()
    })
}

/// Writes to many documents only while the filter matches the number the person confirmed.
async fn check_count(
    collection: &Collection<Document>,
    filter: &Document,
    expected: Option<u64>,
) -> Result<()> {
    let Some(expected) = expected else {
        return Ok(());
    };
    let count = collection
        .count_documents(filter.clone())
        .await
        .map_err(errors::driver)?;
    if count != expected {
        return Err(Error::Validation(format!(
            "The filter now matches {count} documents, not the {expected} confirmed: nothing was changed. Count again."
        )));
    }
    Ok(())
}

/// Puts documents back as they were before recorded changes, newest first, each only if it
/// is still as the change left it.
async fn restore(
    collection: &Collection<Document>,
    changes: Vec<DocumentChange>,
) -> Result<WriteResult> {
    let mut result = WriteResult::default();
    for change in changes.into_iter().rev() {
        let before = change.before.map(|v| required(v, "document")).transpose()?;
        let after = change.after.map(|v| required(v, "document")).transpose()?;
        let changed = || {
            Error::Validation(
                "A document changed after this change: it was not undone. Reload it first.".into(),
            )
        };
        match (&before, &after) {
            (Some(before), Some(after)) => {
                let done = collection
                    .replace_one(unchanged(after)?, before.clone())
                    .await
                    .map_err(errors::driver)?;
                if done.matched_count == 0 {
                    return Err(changed());
                }
                result.matched += 1;
                result.modified += done.modified_count;
            }
            (None, Some(after)) => {
                let done = collection
                    .delete_one(unchanged(after)?)
                    .await
                    .map_err(errors::driver)?;
                if done.deleted_count == 0 {
                    return Err(changed());
                }
                result.deleted += 1;
            }
            (Some(before), None) => {
                collection
                    .insert_one(before.clone())
                    .await
                    .map_err(errors::driver)?;
                result
                    .inserted
                    .push(extended_json_document(by_id(before)?)?["_id"].clone());
            }
            (None, None) => continue,
        }
        // Recorded the other way round, so the undo can be undone.
        result.changes.insert(
            0,
            DocumentChange {
                before: after.map(extended_json_document).transpose()?,
                after: before.map(extended_json_document).transpose()?,
            },
        );
    }
    Ok(result)
}

/// Options of a new collection Nexo passes to `create`.
const CREATE_OPTIONS: [&str; 9] = [
    "capped",
    "size",
    "max",
    "timeseries",
    "validator",
    "validationLevel",
    "validationAction",
    "collation",
    "expireAfterSeconds",
];

pub async fn change(client: &Client, change: CollectionChange) -> Result<()> {
    match change {
        CollectionChange::Create {
            database,
            collection,
            options,
        } => {
            check_name(&database, "database")?;
            check_name(&collection, "collection")?;
            let mut command = doc! {"create": &collection};
            for (key, value) in document(options, "options")?.unwrap_or_default() {
                if !CREATE_OPTIONS.contains(&key.as_str()) {
                    return Err(Error::Validation(format!(
                        "Unknown collection option {key}"
                    )));
                }
                command.insert(key, value);
            }
            client
                .database(&database)
                .run_command(command)
                .await
                .map_err(errors::driver)?;
        }
        CollectionChange::Rename {
            database,
            collection,
            to,
        } => {
            check_name(&database, "database")?;
            check_name(&collection, "collection")?;
            check_name(&to, "collection")?;
            client
                .database("admin")
                .run_command(doc! {
                    "renameCollection": format!("{database}.{collection}"),
                    "to": format!("{database}.{to}"),
                })
                .await
                .map_err(errors::driver)?;
        }
        CollectionChange::Drop {
            database,
            collection,
        } => {
            check_name(&database, "database")?;
            check_name(&collection, "collection")?;
            client
                .database(&database)
                .collection::<Document>(&collection)
                .drop()
                .await
                .map_err(errors::driver)?;
        }
        CollectionChange::DropDatabase { database } => {
            check_name(&database, "database")?;
            client
                .database(&database)
                .drop()
                .await
                .map_err(errors::driver)?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn reads_write_concerns_and_refuses_unacknowledged_ones() {
        assert_eq!(write_concern(None).unwrap(), None);
        let concern = write_concern(Some(json!({"w": "majority", "j": true, "wtimeout": 500})))
            .unwrap()
            .unwrap();
        assert_eq!(concern.w, Some(Acknowledgment::Majority));
        assert_eq!(concern.journal, Some(true));
        assert_eq!(concern.w_timeout, Some(Duration::from_millis(500)));
        assert_eq!(
            write_concern(Some(json!({"w": 2}))).unwrap().unwrap().w,
            Some(Acknowledgment::Nodes(2))
        );
        assert!(
            write_concern(Some(json!({"w": 0})))
                .unwrap_err()
                .to_string()
                .contains("Unacknowledged")
        );
        assert!(write_concern(Some(json!({"j": "yes"}))).is_err());
    }

    #[test]
    fn a_restored_document_must_be_unchanged() {
        let document = doc! {"_id": 1, "at": bson::DateTime::from_millis(5), "n": {"a": [1]}};
        assert_eq!(
            unchanged(&document).unwrap(),
            doc! {
                "_id": 1,
                "$expr": {"$eq": ["$$ROOT", {"$literal": document.clone()}]},
            }
        );
        assert_eq!(by_id(&document).unwrap(), doc! {"_id": 1});
        assert!(by_id(&doc! {"a": 1}).is_err());
    }
}
