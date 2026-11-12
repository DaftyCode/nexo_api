//! Queries: `find` read a page at a time from a cursor that stays open between pages,
//! aggregations read the same way or written with `$out` and `$merge`, `countDocuments`, and
//! cancelling any of them while it runs.
//!
//! Every query (and every explain) carries a `comment` with its identifier. Cancelling stops waiting for it,
//! closes its cursor (the driver sends `killCursors` when a cursor is dropped) and, if the
//! server is still running it, ends it with `killOp`.

mod aggregate;
mod cursor;
mod options;

use crate::{MongoAdapter, errors, limits, within};
pub use aggregate::{aggregate, aggregate_write};
use bson::{Bson, Document, RawDocument, RawDocumentBuf, doc};
pub(crate) use cursor::guarded;
use cursor::{keep, read_page};
use mongodb::{
    Client, Cursor,
    options::{Collation, CountOptions, FindOptions, Hint},
};
use nexo_application::ports::{CountRequest, DocumentPage, FindRequest};
use nexo_domain::{Error, Result};
use options::{collation, hint, page_size};
pub use options::{document, extended_json, extended_json_document};
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

/// The comment a query carries, so `currentOp` finds it to cancel it.
pub(crate) fn comment(id: &str) -> String {
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
            {"command.explain.comment": &running.comment},
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

#[cfg(test)]
mod tests;
