//! Queries: `find` read a page at a time from a cursor that stays open between pages,
//! `countDocuments`, and cancelling either while it runs.
//!
//! Every query carries a `comment` with its identifier. Cancelling stops waiting for it,
//! closes its cursor (the driver sends `killCursors` when a cursor is dropped) and, if the
//! server is still running it, ends it with `killOp`.
use crate::{MongoAdapter, errors, limits, within};
use bson::{Bson, Document, RawDocument, RawDocumentBuf, doc};
use mongodb::{
    Client, Cursor,
    options::{Collation, CountOptions, FindOptions, Hint},
};
use nexo_application::ports::{CountRequest, DocumentPage, FindRequest};
use nexo_domain::{Error, Result};
use serde_json::Value;
use std::{
    sync::{Arc, PoisonError},
    time::Instant,
};
use tokio::sync::Notify;

/// The cursor of a query whose next page has not been read yet.
pub struct Stored {
    cursor: Cursor<RawDocumentBuf>,
    client: Client,
    /// The comment of the query that opened it: `killOp` finds its `getMore` by it.
    comment: String,
    used: Instant,
}

/// A query being run, so it can be cancelled.
pub struct Running {
    stop: Arc<Notify>,
    client: Client,
    comment: String,
}

fn comment(id: &str) -> String {
    format!("nexo:{id}")
}

/// The first page of a query.
pub async fn find(
    adapter: &MongoAdapter,
    client: Client,
    request: FindRequest,
) -> Result<DocumentPage> {
    crate::browse::check_name(&request.database, "database")?;
    crate::browse::check_name(&request.collection, "collection")?;
    let page = page_size(request.page_size)?;
    let filter = document(request.filter, "filter")?.unwrap_or_default();
    let mut options = FindOptions::default();
    options.projection = document(request.projection, "projection")?;
    options.sort = document(request.sort, "sort")?;
    options.collation = collation(request.collation)?;
    options.hint = hint(request.hint)?;
    options.skip = request.skip.filter(|skip| *skip > 0);
    options.limit = request
        .limit
        .map(|limit| i64::try_from(limit).unwrap_or(i64::MAX));
    // One more than a page, so a full page also tells whether there is another one.
    options.batch_size = Some(page as u32 + 1);
    options.max_time = Some(limits::OPERATION);
    let comment = comment(&request.id);
    options.comment = Some(Bson::String(comment.clone()));
    let collection = client
        .database(&request.database)
        .collection::<RawDocumentBuf>(&request.collection);
    let started = Instant::now();
    let (cursor, documents, truncated) = guarded(adapter, &request.id, &client, &comment, async {
        let mut cursor = collection
            .find(filter)
            .with_options(options)
            .await
            .map_err(errors::driver)?;
        let (documents, truncated) = read_page(&mut cursor, page).await?;
        Ok((cursor, documents, truncated))
    })
    .await?;
    Ok(DocumentPage {
        documents,
        cursor: keep(adapter, cursor, client, comment)?,
        truncated,
        elapsed_ms: started.elapsed().as_millis() as u64,
    })
}

/// The next page of a cursor kept by `find`.
pub async fn more(
    adapter: &MongoAdapter,
    cursor: &str,
    id: &str,
    page_size_wanted: u64,
) -> Result<DocumentPage> {
    let page = page_size(page_size_wanted)?;
    let stored = {
        let mut cursors = adapter
            .cursors
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        cursors.retain(|_, stored| stored.used.elapsed() < limits::IDLE);
        cursors.remove(cursor)
    };
    let Some(mut stored) = stored else {
        return Err(Error::Validation(
            "These results are no longer open: run the query again".into(),
        ));
    };
    let started = Instant::now();
    let client = stored.client.clone();
    let comment = stored.comment.clone();
    let (documents, truncated) = guarded(
        adapter,
        id,
        &client,
        &comment,
        read_page(&mut stored.cursor, page),
    )
    .await?;
    Ok(DocumentPage {
        documents,
        cursor: keep(adapter, stored.cursor, client, comment)?,
        truncated,
        elapsed_ms: started.elapsed().as_millis() as u64,
    })
}

/// How many documents match (`countDocuments`).
pub async fn count(adapter: &MongoAdapter, client: Client, request: CountRequest) -> Result<u64> {
    crate::browse::check_name(&request.database, "database")?;
    crate::browse::check_name(&request.collection, "collection")?;
    let filter = document(request.filter, "filter")?.unwrap_or_default();
    let mut options = CountOptions::default();
    options.collation = collation(request.collation)?;
    options.hint = hint(request.hint)?;
    options.skip = request.skip.filter(|skip| *skip > 0);
    options.limit = request.limit;
    options.max_time = Some(limits::OPERATION);
    let comment = comment(&request.id);
    options.comment = Some(Bson::String(comment.clone()));
    let collection = client
        .database(&request.database)
        .collection::<Document>(&request.collection);
    guarded(adapter, &request.id, &client, &comment, async {
        collection
            .count_documents(filter)
            .with_options(options)
            .await
            .map_err(errors::driver)
    })
    .await
}

/// Cancels a running query. Whether one was running with that identifier.
pub async fn cancel(adapter: &MongoAdapter, id: &str) -> bool {
    let running = adapter
        .running
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .remove(id);
    let Some(running) = running else {
        return false;
    };
    running.stop.notify_one();
    // The server may still be running it (a sort without an index, a count): end it. Users
    // without the privilege to see or end operations still get their cursor closed.
    let admin = running.client.database("admin");
    let filter = doc! {
        "currentOp": true,
        "$or": [
            {"command.comment": &running.comment},
            {"cursor.originatingCommand.comment": &running.comment},
        ],
    };
    if let Ok(Ok(answer)) = tokio::time::timeout(limits::CONNECT, admin.run_command(filter)).await {
        for operation in answer.get_array("inprog").into_iter().flatten() {
            if let Some(id) = operation.as_document().and_then(|op| op.get("opid")) {
                let _ = tokio::time::timeout(
                    limits::CONNECT,
                    admin.run_command(doc! {"killOp": 1, "op": id.clone()}),
                )
                .await;
            }
        }
    }
    true
}

/// Runs a query so that `cancel` can stop it, within the operation limit.
async fn guarded<T>(
    adapter: &MongoAdapter,
    id: &str,
    client: &Client,
    comment: &str,
    work: impl std::future::Future<Output = Result<T>>,
) -> Result<T> {
    let stop = Arc::new(Notify::new());
    adapter
        .running
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .insert(
            id.to_string(),
            Running {
                stop: stop.clone(),
                client: client.clone(),
                comment: comment.to_string(),
            },
        );
    let result = tokio::select! {
        result = within(work) => result,
        () = stop.notified() => Err(Error::Validation("The query was cancelled".into())),
    };
    adapter
        .running
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .remove(id);
    result
}

/// Keeps a cursor that may have more documents, and names it for `more`.
fn keep(
    adapter: &MongoAdapter,
    cursor: Cursor<RawDocumentBuf>,
    client: Client,
    comment: String,
) -> Result<Option<String>> {
    if !cursor.has_next() {
        return Ok(None);
    }
    let name = uuid::Uuid::new_v4().to_string();
    let mut cursors = adapter
        .cursors
        .lock()
        .unwrap_or_else(PoisonError::into_inner);
    cursors.retain(|_, stored| stored.used.elapsed() < limits::IDLE);
    if cursors.len() >= limits::CURSORS
        && let Some(oldest) = cursors
            .iter()
            .min_by_key(|(_, stored)| stored.used)
            .map(|(name, _)| name.clone())
    {
        cursors.remove(&oldest);
    }
    cursors.insert(
        name.clone(),
        Stored {
            cursor,
            client,
            comment,
            used: Instant::now(),
        },
    );
    Ok(Some(name))
}

/// Reads up to `page` documents, stopping early when they reach the size the interface
/// receives at once.
async fn read_page(cursor: &mut Cursor<RawDocumentBuf>, page: u64) -> Result<(Vec<Value>, bool)> {
    let mut documents = Vec::new();
    let mut bytes = 0;
    while (documents.len() as u64) < page {
        if !cursor.advance().await.map_err(errors::driver)? {
            break;
        }
        let document = extended_json(cursor.current())?;
        bytes += serde_json::to_vec(&document).map_or(0, |text| text.len());
        documents.push(document);
        if bytes >= limits::RESPONSE_BYTES {
            return Ok((documents, true));
        }
    }
    Ok((documents, false))
}

/// A document in canonical Extended JSON, so every BSON type survives the trip.
pub fn extended_json(raw: &RawDocument) -> Result<Value> {
    let document = Document::try_from(raw)
        .map_err(|error| Error::Validation(format!("A document could not be read: {error}")))?;
    Ok(Bson::Document(document).into_canonical_extjson())
}

fn page_size(page: u64) -> Result<u64> {
    if (1..=limits::PAGE_DOCUMENTS).contains(&page) {
        Ok(page)
    } else {
        Err(Error::Validation(format!(
            "A page has between 1 and {} documents",
            limits::PAGE_DOCUMENTS
        )))
    }
}

/// An Extended JSON object (canonical or relaxed) as a BSON document.
pub fn document(value: Option<Value>, what: &str) -> Result<Option<Document>> {
    let Some(value) = value else {
        return Ok(None);
    };
    match Bson::try_from(value) {
        Ok(Bson::Document(document)) => Ok(Some(document)),
        Ok(_) => Err(Error::Validation(format!("The {what} must be a document"))),
        Err(error) => Err(Error::Validation(format!(
            "Invalid Extended JSON in the {what}: {error}"
        ))),
    }
}

fn collation(value: Option<Value>) -> Result<Option<Collation>> {
    let Some(document) = document(value, "collation")? else {
        return Ok(None);
    };
    bson::deserialize_from_document(document)
        .map(Some)
        .map_err(|error| Error::Validation(format!("Invalid collation: {error}")))
}

/// An index name, or the keys of an index.
fn hint(value: Option<Value>) -> Result<Option<Hint>> {
    match value {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(name)) if name.trim().is_empty() => Ok(None),
        Some(Value::String(name)) => Ok(Some(Hint::Name(name))),
        Some(keys @ Value::Object(_)) => Ok(document(Some(keys), "hint")?.map(Hint::Keys)),
        Some(_) => Err(Error::Validation(
            "The hint is an index name or its keys".into(),
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn reads_canonical_and_relaxed_extended_json() {
        let filter = document(
            Some(json!({
                "_id": {"$oid": "65a1b2c3d4e5f6a7b8c9d0e1"},
                "at": {"$gte": {"$date": "2024-01-02T03:04:05Z"}},
                "big": {"$numberLong": "9007199254740993"},
                "price": {"$numberDecimal": "1.10"},
                "n": 3,
            })),
            "filter",
        )
        .unwrap()
        .unwrap();
        assert!(matches!(filter.get("_id"), Some(Bson::ObjectId(_))));
        assert!(matches!(
            filter.get_document("at").unwrap().get("$gte"),
            Some(Bson::DateTime(_))
        ));
        assert_eq!(filter.get("big"), Some(&Bson::Int64(9_007_199_254_740_993)));
        assert!(matches!(filter.get("price"), Some(Bson::Decimal128(_))));
        assert_eq!(filter.get("n"), Some(&Bson::Int32(3)));
        // Keys keep their order: it is the order of a sort.
        let sort = document(Some(json!({"b": 1, "a": -1})), "sort")
            .unwrap()
            .unwrap();
        assert_eq!(sort.keys().collect::<Vec<_>>(), ["b", "a"]);
        assert_eq!(
            document(Some(json!([1])), "sort").unwrap_err().to_string(),
            "The sort must be a document"
        );
        assert!(
            document(Some(json!({"a": {"$oid": "nope"}})), "filter")
                .unwrap_err()
                .to_string()
                .starts_with("Invalid Extended JSON in the filter")
        );
    }

    #[test]
    fn writes_documents_in_canonical_extended_json() {
        let raw = RawDocumentBuf::try_from(&doc! {
            "_id": bson::oid::ObjectId::parse_str("65a1b2c3d4e5f6a7b8c9d0e1").unwrap(),
            "n": 1_i32, "big": 2_i64, "x": 1.5,
        })
        .unwrap();
        assert_eq!(
            extended_json(&raw).unwrap(),
            json!({
                "_id": {"$oid": "65a1b2c3d4e5f6a7b8c9d0e1"},
                "n": {"$numberInt": "1"},
                "big": {"$numberLong": "2"},
                "x": {"$numberDouble": "1.5"},
            })
        );
    }

    #[test]
    fn reads_hints_collations_and_page_sizes() {
        assert_eq!(
            hint(Some(json!("at_1"))).unwrap(),
            Some(Hint::Name("at_1".into()))
        );
        assert_eq!(hint(Some(json!(""))).unwrap(), None);
        assert_eq!(
            hint(Some(json!({"at": 1}))).unwrap(),
            Some(Hint::Keys(doc! {"at": 1}))
        );
        assert!(hint(Some(json!(1))).is_err());
        let collation = collation(Some(json!({"locale": "es", "strength": 1})))
            .unwrap()
            .unwrap();
        assert_eq!(collation.locale, "es");
        assert!(
            super::collation(Some(json!({"strength": 1})))
                .unwrap_err()
                .to_string()
                .starts_with("Invalid collation")
        );
        assert!(page_size(0).is_err());
        assert!(page_size(1_001).is_err());
        assert_eq!(page_size(50).unwrap(), 50);
    }
}
