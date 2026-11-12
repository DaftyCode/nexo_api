//! Writes: documents (insert, update, replace, delete and restoring recorded changes) and
//! collections and databases. Single-document writes use `findOneAnd…` so the document
//! before the write is known, and read it again after, to record both for undo.

mod collections;
mod documents;

use crate::{
    browse::check_name,
    errors,
    query::{document, extended_json_document},
};
use bson::{Document, doc, oid::ObjectId};
pub use collections::change;
use documents::{insert, restore, single};
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

#[cfg(test)]
mod tests;
