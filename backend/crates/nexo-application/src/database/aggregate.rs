//! Aggregations. One that only reads is read a page at a time, like a `find`, and never
//! carries a stage that writes. One that ends in `$out` or `$merge` is a write: refused on a
//! read-only connection (in `writes`), and run only after the person repeats the name of the
//! collection it writes. Its results are not recorded to undo them.
use super::{DATABASE_PAGE, confirmed, read};
use crate::{
    Application,
    payloads::{MongoAggregatePayload, MongoAggregateWritePayload},
    ports::{
        AggregateOptions, AggregateRequest, AggregateWrite, DatabaseConnection, writing_stage,
    },
};
use nexo_domain::{Error, Result};
use serde_json::{Map, Value, json};

/// The stages of a pipeline as Extended JSON values; at least one.
fn stages(pipeline: Vec<Map<String, Value>>) -> Result<Vec<Value>> {
    if pipeline.is_empty() {
        return Err(Error::Validation("Add at least one stage".into()));
    }
    Ok(pipeline.into_iter().map(Value::Object).collect())
}

/// The collection a writing stage writes to: its name, and its database when it names one.
pub(crate) fn written(stage: &Value, database: &str) -> Result<(String, String)> {
    let invalid =
        || Error::Validation("The last stage does not name the collection it writes".into());
    let (name, value) = stage
        .as_object()
        .and_then(|fields| fields.iter().next())
        .ok_or_else(invalid)?;
    // `$merge` names it in `into` when it has options; `$out` in the stage itself.
    let target = match (name.as_str(), value) {
        ("$merge", Value::Object(options)) => options.get("into").ok_or_else(invalid)?,
        _ => value,
    };
    match target {
        Value::String(collection) if !collection.trim().is_empty() => {
            Ok((database.to_string(), collection.clone()))
        }
        Value::Object(names) => match (names.get("db"), names.get("coll")) {
            (Some(Value::String(db)), Some(Value::String(coll))) if !coll.trim().is_empty() => {
                Ok((db.clone(), coll.clone()))
            }
            _ => Err(invalid()),
        },
        _ => Err(invalid()),
    }
}

impl Application {
    /// The first page of an aggregation that only reads.
    pub(super) async fn aggregate(
        &self,
        payload: Value,
        connection: DatabaseConnection,
    ) -> Result<Value> {
        let p: MongoAggregatePayload = read(&payload)?;
        let pipeline = stages(p.pipeline)?;
        if let Some(stage) = pipeline.iter().find_map(writing_stage) {
            return Err(Error::Validation(format!(
                "A pipeline with {stage} writes: run it as a write, with its confirmation"
            )));
        }
        let request = AggregateRequest {
            id: p.id,
            database: p.database,
            collection: p.collection,
            pipeline,
            options: AggregateOptions {
                collation: p.collation.map(Value::Object),
                hint: p.hint,
                allow_disk_use: p.allow_disk_use.unwrap_or(false),
                max_time_ms: p.max_time_ms.filter(|ms| *ms > 0),
            },
            page_size: p.page_size.unwrap_or(DATABASE_PAGE),
        };
        let page = self.database.aggregate(connection, request).await?;
        serde_json::to_value(page).map_err(|error| Error::Infrastructure(error.to_string()))
    }

    /// Runs an aggregation that writes with `$out` or `$merge`, its last stage, once the
    /// name of the collection written is repeated.
    pub(super) async fn aggregate_write(
        &self,
        payload: &Value,
        connection: DatabaseConnection,
    ) -> Result<Value> {
        let p: MongoAggregateWritePayload = read(payload)?;
        let pipeline = stages(p.pipeline)?;
        let (last, before) = pipeline.split_last().expect("at least one stage");
        if writing_stage(last).is_none() {
            return Err(Error::Validation(
                "Only a pipeline that ends in $out or $merge runs as a write".into(),
            ));
        }
        if let Some(stage) = before.iter().find_map(writing_stage) {
            return Err(Error::Validation(format!(
                "{stage} can only be the last stage"
            )));
        }
        let (database, collection) = written(last, &p.database)?;
        confirmed(Some(&p.confirm), &collection, "collection")?;
        let request = AggregateWrite {
            id: p.id,
            database: p.database,
            collection: p.collection,
            pipeline,
            options: AggregateOptions {
                collation: p.collation.map(Value::Object),
                hint: p.hint,
                allow_disk_use: p.allow_disk_use.unwrap_or(false),
                max_time_ms: p.max_time_ms.filter(|ms| *ms > 0),
            },
        };
        let elapsed = self.database.aggregate_write(connection, request).await?;
        Ok(json!({ "database": database, "collection": collection, "elapsedMs": elapsed }))
    }
}
