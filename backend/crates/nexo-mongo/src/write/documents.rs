//! Inserting, changing one document and restoring documents to undo a change.
use super::*;

pub(super) async fn insert(
    collection: &Collection<Document>,
    documents: Vec<Value>,
) -> Result<WriteResult> {
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
pub(super) async fn single(
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

/// Puts documents back as they were before recorded changes, newest first, each only if it
/// is still as the change left it.
pub(super) async fn restore(
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
