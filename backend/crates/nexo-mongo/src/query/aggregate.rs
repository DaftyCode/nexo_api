//! Aggregations: a pipeline that reads, a page at a time through a cursor kept like the one
//! of a `find`, and a pipeline that writes with `$out` or `$merge`, run to its end.
use super::*;
use mongodb::options::AggregateOptions as DriverOptions;
use nexo_application::ports::{AggregateOptions, AggregateRequest, AggregateWrite};

/// Each stage as a BSON document.
fn pipeline(stages: Vec<Value>) -> Result<Vec<Document>> {
    stages
        .into_iter()
        .map(|stage| {
            document(Some(stage), "pipeline stage")?
                .ok_or_else(|| Error::Validation("A pipeline stage is a document".into()))
        })
        .collect()
}

/// The driver's options, with the time limit never above the adapter's.
fn options(wanted: AggregateOptions, comment: &str) -> Result<DriverOptions> {
    let limit = limits::OPERATION.as_millis() as u64;
    let max_time = match wanted.max_time_ms {
        Some(ms) if ms > limit => {
            return Err(Error::Validation(format!(
                "maxTimeMS is at most {limit}: the operation limit of Nexo"
            )));
        }
        Some(ms) => std::time::Duration::from_millis(ms),
        None => limits::OPERATION,
    };
    let mut options = DriverOptions::default();
    options.collation = collation(wanted.collation)?;
    options.hint = hint(wanted.hint)?;
    options.allow_disk_use = wanted.allow_disk_use.then_some(true);
    options.max_time = Some(max_time);
    options.comment = Some(Bson::String(comment.to_string()));
    Ok(options)
}

/// The first page of an aggregation that only reads.
pub async fn aggregate(
    adapter: &MongoAdapter,
    client: Client,
    request: AggregateRequest,
) -> Result<DocumentPage> {
    crate::browse::check_name(&request.database, "database")?;
    crate::browse::check_name(&request.collection, "collection")?;
    let page = page_size(request.page_size)?;
    let stages = pipeline(request.pipeline)?;
    let comment = comment(&request.id);
    let mut options = options(request.options, &comment)?;
    // One more than a page, so a full page also tells whether there is another one.
    options.batch_size = Some(page as u32 + 1);
    let collection = client
        .database(&request.database)
        .collection::<Document>(&request.collection);
    let started = Instant::now();
    let (cursor, documents, truncated) = guarded(adapter, &request.id, &client, &comment, async {
        let mut cursor = collection
            .aggregate(stages)
            .with_options(options)
            .await
            .map_err(errors::driver)?
            .with_type::<RawDocumentBuf>();
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

/// Runs an aggregation whose last stage writes. How long it took, in milliseconds.
pub async fn aggregate_write(
    adapter: &MongoAdapter,
    client: Client,
    request: AggregateWrite,
) -> Result<u64> {
    crate::browse::check_name(&request.database, "database")?;
    crate::browse::check_name(&request.collection, "collection")?;
    let stages = pipeline(request.pipeline)?;
    let comment = comment(&request.id);
    let options = options(request.options, &comment)?;
    let collection = client
        .database(&request.database)
        .collection::<Document>(&request.collection);
    let started = Instant::now();
    guarded(adapter, &request.id, &client, &comment, async {
        // `$out` and `$merge` write while the command runs; the cursor it opens is empty.
        let mut cursor = collection
            .aggregate(stages)
            .with_options(options)
            .await
            .map_err(errors::driver)?;
        while cursor.advance().await.map_err(errors::driver)? {}
        Ok(())
    })
    .await?;
    Ok(started.elapsed().as_millis() as u64)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn options_keep_the_time_limit_and_read_collation_and_hint() {
        let built = options(
            AggregateOptions {
                collation: Some(json!({"locale": "es"})),
                hint: Some(json!({"a": 1})),
                allow_disk_use: true,
                max_time_ms: Some(1500),
            },
            "nexo:a",
        )
        .unwrap();
        assert_eq!(built.max_time, Some(std::time::Duration::from_millis(1500)));
        assert_eq!(built.allow_disk_use, Some(true));
        assert_eq!(built.collation.unwrap().locale, "es");
        assert_eq!(built.comment, Some(Bson::String("nexo:a".into())));
        let default = options(AggregateOptions::default(), "nexo:b").unwrap();
        assert_eq!(default.max_time, Some(limits::OPERATION));
        assert_eq!(default.allow_disk_use, None);
        let error = options(
            AggregateOptions {
                max_time_ms: Some(limits::OPERATION.as_millis() as u64 + 1),
                ..Default::default()
            },
            "nexo:c",
        )
        .unwrap_err();
        assert!(
            error.to_string().contains("maxTimeMS is at most 60000"),
            "{error}"
        );
    }

    #[test]
    fn stages_are_documents_with_their_bson_types() {
        let stages = pipeline(vec![
            json!({"$match": {"at": {"$gte": {"$date": "2024-01-02T00:00:00Z"}}}}),
            json!({"$limit": 5}),
        ])
        .unwrap();
        assert!(matches!(
            stages[0]
                .get_document("$match")
                .unwrap()
                .get_document("at")
                .unwrap()
                .get("$gte"),
            Some(Bson::DateTime(_))
        ));
        assert!(pipeline(vec![json!(["$match"])]).is_err());
    }
}
