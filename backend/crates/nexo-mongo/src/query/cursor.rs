//! Cursors kept between pages: guarded by a time limit and read one page at a time.
use super::*;

/// Runs a query so that `cancel` can stop it, within the operation limit.
pub(crate) async fn guarded<T>(
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
pub(super) fn keep(
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
pub(super) async fn read_page(
    cursor: &mut Cursor<RawDocumentBuf>,
    page: u64,
) -> Result<(Vec<Value>, bool)> {
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
