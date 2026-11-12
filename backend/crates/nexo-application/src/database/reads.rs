//! Database operations that only read: connections, browsing, queries, explain and the
//! profiler.
use super::DATABASE_PAGE;
use crate::{Application, operations::Operation, payloads, ports};
use nexo_domain::{Error, Result};
use serde_json::{Map, Value};

/// Profiler entries listed at most, the slowest first.
const PROFILE_ENTRIES: u64 = 100;

impl Application {
    pub(super) async fn database_read(
        &self,
        operation: Operation,
        payload: Value,
        values: &mut Vec<(String, String)>,
    ) -> Result<Value> {
        fn read<T: serde::de::DeserializeOwned>(payload: Value) -> Result<T> {
            serde_json::from_value(payload).map_err(|error| Error::Validation(error.to_string()))
        }
        fn object(value: Option<Map<String, Value>>) -> Option<Value> {
            value.map(Value::Object)
        }
        fn answer<T: serde::Serialize>(value: T) -> Result<Value> {
            serde_json::to_value(value).map_err(|error| Error::Infrastructure(error.to_string()))
        }
        let database = &self.database;
        match operation {
            Operation::MongoTest => {
                let payload: payloads::MongoConnectionPayload = read(payload)?;
                let connection = self.resolve_connection(payload.connection, values).await?;
                answer(database.test(connection).await?)
            }
            Operation::MongoDatabases => {
                let payload: payloads::MongoConnectionPayload = read(payload)?;
                let connection = self.resolve_connection(payload.connection, values).await?;
                Ok(
                    serde_json::json!({ "databases": answer(database.databases(connection).await?)? }),
                )
            }
            Operation::MongoCollections => {
                let payload: payloads::MongoDatabasePayload = read(payload)?;
                let connection = self.resolve_connection(payload.connection, values).await?;
                let collections = database.collections(connection, &payload.database).await?;
                Ok(serde_json::json!({ "collections": answer(collections)? }))
            }
            Operation::MongoStats => {
                let payload: payloads::MongoCollectionPayload = read(payload)?;
                let connection = self.resolve_connection(payload.connection, values).await?;
                answer(
                    database
                        .stats(connection, &payload.database, &payload.collection)
                        .await?,
                )
            }
            Operation::MongoFind => {
                let payload: payloads::MongoFindPayload = read(payload)?;
                let connection = self.resolve_connection(payload.connection, values).await?;
                let request = ports::FindRequest {
                    id: payload.id,
                    database: payload.database,
                    collection: payload.collection,
                    filter: object(payload.filter),
                    projection: object(payload.projection),
                    sort: object(payload.sort),
                    collation: object(payload.collation),
                    hint: payload.hint,
                    skip: payload.skip,
                    limit: payload.limit.filter(|limit| *limit > 0),
                    page_size: payload.page_size.unwrap_or(DATABASE_PAGE),
                };
                answer(database.find(connection, request).await?)
            }
            Operation::MongoAggregate => {
                let sent: payloads::MongoConnection = read(payload["connection"].clone())?;
                let connection = self.resolve_connection(sent, values).await?;
                self.aggregate(payload, connection).await
            }
            Operation::MongoSchema => {
                let sent: payloads::MongoConnection = read(payload["connection"].clone())?;
                let connection = self.resolve_connection(sent, values).await?;
                self.schema(payload, connection).await
            }
            Operation::MongoMore => {
                let payload: payloads::MongoMorePayload = read(payload)?;
                answer(
                    database
                        .more(
                            &payload.cursor,
                            &payload.id,
                            payload.page_size.unwrap_or(DATABASE_PAGE),
                        )
                        .await?,
                )
            }
            Operation::MongoCount => {
                let payload: payloads::MongoCountPayload = read(payload)?;
                let connection = self.resolve_connection(payload.connection, values).await?;
                let request = ports::CountRequest {
                    id: payload.id,
                    database: payload.database,
                    collection: payload.collection,
                    filter: object(payload.filter),
                    collation: object(payload.collation),
                    hint: payload.hint,
                    skip: payload.skip,
                    limit: payload.limit.filter(|limit| *limit > 0),
                };
                Ok(serde_json::json!({ "count": database.count(connection, request).await? }))
            }
            Operation::MongoCancel => {
                let payload: payloads::IdPayload = read(payload)?;
                Ok(serde_json::json!({ "cancelled": database.cancel(&payload.id).await? }))
            }
            Operation::MongoClose => {
                let payload: payloads::MongoClosePayload = read(payload)?;
                database.close(&payload.cursor).await?;
                Ok(serde_json::json!({ "closed": true }))
            }
            Operation::MongoIndexes => {
                let payload: payloads::MongoCollectionPayload = read(payload)?;
                let connection = self.resolve_connection(payload.connection, values).await?;
                let indexes = database
                    .indexes(connection, &payload.database, &payload.collection)
                    .await?;
                Ok(serde_json::json!({ "indexes": answer(indexes)? }))
            }
            Operation::MongoExplain => {
                let payload: payloads::MongoExplainPayload = read(payload)?;
                let connection = self.resolve_connection(payload.connection, values).await?;
                let explained = match payload.pipeline {
                    Some(pipeline) => ports::Explained::Aggregate {
                        pipeline: pipeline.into_iter().map(Value::Object).collect(),
                        collation: object(payload.collation),
                        hint: payload.hint,
                    },
                    None => ports::Explained::Find(Box::new(ports::FindRequest {
                        id: payload.id.clone(),
                        database: payload.database.clone(),
                        collection: payload.collection.clone(),
                        filter: object(payload.filter),
                        projection: object(payload.projection),
                        sort: object(payload.sort),
                        collation: object(payload.collation),
                        hint: payload.hint,
                        skip: payload.skip,
                        limit: payload.limit.filter(|limit| *limit > 0),
                        page_size: DATABASE_PAGE,
                    })),
                };
                let request = ports::ExplainRequest {
                    id: payload.id,
                    database: payload.database,
                    collection: payload.collection,
                    explained,
                    execution_stats: payload.verbosity
                        == Some(payloads::ExplainVerbosity::ExecutionStats),
                };
                Ok(serde_json::json!({ "explain": database.explain(connection, request).await? }))
            }
            Operation::MongoProfile => {
                let payload: payloads::MongoProfilePayload = read(payload)?;
                let connection = self.resolve_connection(payload.connection, values).await?;
                answer(
                    database
                        .profile(connection, &payload.database, None)
                        .await?,
                )
            }
            Operation::MongoProfileEntries => {
                let payload: payloads::MongoProfileEntriesPayload = read(payload)?;
                let connection = self.resolve_connection(payload.connection, values).await?;
                let limit = payload
                    .limit
                    .unwrap_or(PROFILE_ENTRIES)
                    .clamp(1, PROFILE_ENTRIES);
                let entries = database
                    .profiled(
                        connection,
                        &payload.database,
                        payload
                            .collection
                            .as_deref()
                            .filter(|name| !name.is_empty()),
                        limit,
                    )
                    .await?;
                Ok(serde_json::json!({ "entries": answer(entries)? }))
            }
            _ => Err(Error::Validation("Unknown database operation".into())),
        }
    }
}
