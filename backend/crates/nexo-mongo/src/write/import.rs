//! Imports: a batch inserted with `insertMany`, or written document by document with an
//! upsert by the values of some fields. Without `ordered`, the documents that fail are
//! reported by their position and the others are written.
use super::{required, write_concern};
use crate::{browse::check_name, errors};
use bson::{Bson, Document};
use mongodb::{
    Client, Collection,
    error::{Error as DriverError, ErrorKind, WriteFailure},
    options::CollectionOptions,
};
use nexo_application::ports::{ImportBatch, ImportFailure, ImportResult, WriteTarget};
use nexo_domain::Result;

pub async fn import(
    client: &Client,
    target: WriteTarget,
    batch: ImportBatch,
) -> Result<ImportResult> {
    check_name(&target.database, "database")?;
    check_name(&target.collection, "collection")?;
    let mut options = CollectionOptions::default();
    options.write_concern = write_concern(target.write_concern)?;
    let collection: Collection<Document> = client
        .database(&target.database)
        .collection_with_options(&target.collection, options);
    // Documents that cannot be read are failures of the batch, like the server's.
    let mut documents = Vec::with_capacity(batch.documents.len());
    let mut unreadable = Vec::new();
    for (index, value) in batch.documents.into_iter().enumerate() {
        match required(value, "document") {
            Ok(document) => documents.push((index, document)),
            Err(error) => unreadable.push(ImportFailure {
                index: index as u64,
                message: error.to_string(),
            }),
        }
    }
    if batch.ordered && !unreadable.is_empty() {
        // Nothing is written past the first unreadable document.
        let first = unreadable[0].index as usize;
        documents.retain(|(index, _)| *index < first);
        unreadable.truncate(1);
    }
    let mut result = ImportResult::default();
    if batch.clear {
        let deleted = collection
            .delete_many(Document::new())
            .await
            .map_err(errors::driver)?;
        result.cleared = deleted.deleted_count;
    }
    match batch.upsert_key {
        None => insert(&collection, documents, batch.ordered, &mut result).await?,
        Some(key) => upsert(&collection, documents, &key, batch.ordered, &mut result).await,
    }
    result.failed.extend(unreadable);
    result.failed.sort_by_key(|failure| failure.index);
    Ok(result)
}

async fn insert(
    collection: &Collection<Document>,
    documents: Vec<(usize, Document)>,
    ordered: bool,
    result: &mut ImportResult,
) -> Result<()> {
    if documents.is_empty() {
        return Ok(());
    }
    let positions: Vec<usize> = documents.iter().map(|(index, _)| *index).collect();
    let documents: Vec<Document> = documents
        .into_iter()
        .map(|(_, document)| document)
        .collect();
    let total = documents.len() as u64;
    match collection.insert_many(documents).ordered(ordered).await {
        Ok(inserted) => result.inserted += inserted.inserted_ids.len() as u64,
        Err(error) => match error.kind.as_ref() {
            ErrorKind::InsertMany(failure) if failure.write_concern_error.is_none() => {
                let failed: Vec<ImportFailure> = failure
                    .write_errors
                    .iter()
                    .flatten()
                    .map(|failed| ImportFailure {
                        index: positions.get(failed.index).copied().unwrap_or(failed.index) as u64,
                        message: failed.message.clone(),
                    })
                    .collect();
                result.inserted += if ordered {
                    // An ordered insert stops at the first failure: those before it are in.
                    failure
                        .write_errors
                        .iter()
                        .flatten()
                        .map(|failed| failed.index as u64)
                        .min()
                        .unwrap_or(total)
                } else {
                    total - failed.len() as u64
                };
                result.failed.extend(failed);
            }
            _ => return Err(errors::driver(error)),
        },
    }
    Ok(())
}

async fn upsert(
    collection: &Collection<Document>,
    documents: Vec<(usize, Document)>,
    key: &[String],
    ordered: bool,
    result: &mut ImportResult,
) {
    for (index, document) in documents {
        let outcome = match filter(&document, key) {
            Ok(filter) => collection
                .replace_one(filter, &document)
                .upsert(true)
                .await
                .map_err(message),
            Err(missing) => Err(missing),
        };
        match outcome {
            Ok(written) if written.upserted_id.is_some() => result.upserted += 1,
            Ok(written) if written.matched_count > 0 => result.replaced += 1,
            Ok(_) => {}
            Err(message) => {
                result.failed.push(ImportFailure {
                    index: index as u64,
                    message,
                });
                if ordered {
                    break;
                }
            }
        }
    }
}

/// The filter of the document to replace: the values of the key fields, which may be
/// dotted paths into embedded documents.
fn filter(document: &Document, key: &[String]) -> std::result::Result<Document, String> {
    let mut filter = Document::new();
    for field in key {
        let value =
            lookup(document, field).ok_or_else(|| format!("The document has no {field}"))?;
        filter.insert(field.clone(), value.clone());
    }
    Ok(filter)
}

fn lookup<'a>(document: &'a Document, path: &str) -> Option<&'a Bson> {
    let mut parts = path.split('.');
    let mut value = document.get(parts.next()?)?;
    for part in parts {
        value = value.as_document()?.get(part)?;
    }
    Some(value)
}

/// The reason a document was not written: the server's message for a write error.
fn message(error: DriverError) -> String {
    match error.kind.as_ref() {
        ErrorKind::Write(WriteFailure::WriteError(failed)) => failed.message.clone(),
        _ => errors::driver(error).to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use bson::doc;

    #[test]
    fn upsert_filters_take_the_key_values_also_from_embedded_documents() {
        let document = doc! {"_id": 1, "sku": "A-1", "store": {"city": "Madrid"}};
        let key = ["sku".to_string(), "store.city".to_string()];
        assert_eq!(
            filter(&document, &key).unwrap(),
            doc! {"sku": "A-1", "store.city": "Madrid"}
        );
        let missing = ["price".to_string()];
        assert_eq!(
            filter(&document, &missing).unwrap_err(),
            "The document has no price"
        );
    }
}
