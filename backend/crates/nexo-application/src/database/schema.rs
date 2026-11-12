//! The schema explorer: a random sample of a collection (or of the documents a filter
//! matches) read through the aggregation port, its schema analysed by the domain, and the
//! JSON Schema and MongoDB validator that schema gives.
use super::read;
use crate::{
    Application,
    payloads::MongoSchemaPayload,
    ports::{AggregateOptions, AggregateRequest, DatabaseConnection},
};
use nexo_domain::{
    Error, Result,
    schema::{Flavor, SchemaDialect, analyze, json_schema},
};
use serde_json::{Value, json};
use std::time::Instant;

/// Documents sampled when the client does not say.
pub(crate) const SAMPLE: u64 = 1_000;
/// Documents sampled at most: the analysis runs in memory.
pub(crate) const SAMPLE_MAX: u64 = 10_000;
/// Documents read at once from the sample's cursor.
const PAGE: u64 = 1_000;

impl Application {
    pub(super) async fn schema(
        &self,
        payload: Value,
        connection: DatabaseConnection,
    ) -> Result<Value> {
        let p: MongoSchemaPayload = read(&payload)?;
        let size = p.size.unwrap_or(SAMPLE);
        if !(1..=SAMPLE_MAX).contains(&size) {
            return Err(Error::Validation(format!(
                "A sample has between 1 and {SAMPLE_MAX} documents"
            )));
        }
        let mut pipeline = Vec::new();
        if let Some(filter) = p.filter.filter(|filter| !filter.is_empty()) {
            pipeline.push(json!({ "$match": filter }));
        }
        pipeline.push(json!({ "$sample": { "size": size } }));
        let started = Instant::now();
        let request = AggregateRequest {
            id: p.id.clone(),
            database: p.database,
            collection: p.collection,
            pipeline,
            options: AggregateOptions::default(),
            page_size: PAGE,
        };
        let mut page = self.database.aggregate(connection, request).await?;
        let mut documents = std::mem::take(&mut page.documents);
        while let Some(cursor) = page.cursor.take() {
            page = self.database.more(&cursor, &p.id, PAGE).await?;
            documents.append(&mut page.documents);
        }
        let report = analyze(&documents, Flavor::Bson);
        let validator = json_schema(&report, SchemaDialect::MongoValidator);
        let schema = json_schema(&report, SchemaDialect::JsonSchema);
        let mut answer = serde_json::to_value(report)
            .map_err(|error| Error::Infrastructure(error.to_string()))?;
        answer["elapsedMs"] = json!(started.elapsed().as_millis() as u64);
        answer["validator"] = validator;
        answer["jsonSchema"] = schema;
        Ok(answer)
    }
}
