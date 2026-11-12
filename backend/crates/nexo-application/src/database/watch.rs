//! Change streams in the realtime panel: `mongo.watch` opens one on a saved or typed
//! connection, and the realtime operations reach it by its identifier, so the panel reads,
//! closes and lists it like its other connections.
use super::read;
use crate::{
    Application,
    operations::Operation,
    payloads::MongoWatchPayload,
    ports::{DatabaseConnection, WATCH_PREFIX, WatchRequest},
};
use nexo_domain::{Error, Result};
use serde_json::{Map, Value, json};

const FULL_DOCUMENT: [&str; 4] = ["default", "updateLookup", "whenAvailable", "required"];
const BEFORE_CHANGE: [&str; 3] = ["off", "whenAvailable", "required"];

fn one_of(value: Option<String>, allowed: &[&str], what: &str) -> Result<Option<String>> {
    match value {
        Some(value) if !allowed.contains(&value.as_str()) => Err(Error::Validation(format!(
            "{what} is one of {}",
            allowed.join(", ")
        ))),
        value => Ok(value),
    }
}

/// What a change stream watches and how, from its payload.
fn watch_request(p: MongoWatchPayload) -> Result<WatchRequest> {
    let name = |value: Option<String>| {
        value
            .map(|v| v.trim().to_string())
            .filter(|v| !v.is_empty())
    };
    let database = name(p.database);
    let collection = name(p.collection);
    if collection.is_some() && database.is_none() {
        return Err(Error::Validation(
            "Choose the database of the collection to watch".into(),
        ));
    }
    let resume_after = match p.resume_after {
        None | Some(Value::Null) => None,
        Some(Value::String(token)) if token.trim().is_empty() => None,
        Some(Value::String(token)) => Some(json!({ "_data": token.trim() })),
        Some(token @ Value::Object(_)) => Some(token),
        Some(_) => {
            return Err(Error::Validation(
                "A resume token is the text of its _data, or the token itself".into(),
            ));
        }
    };
    Ok(WatchRequest {
        database,
        collection,
        pipeline: p
            .pipeline
            .unwrap_or_default()
            .into_iter()
            .map(Value::Object)
            .collect(),
        full_document: one_of(p.full_document, &FULL_DOCUMENT, "fullDocument")?,
        full_document_before_change: one_of(
            p.full_document_before_change,
            &BEFORE_CHANGE,
            "fullDocumentBeforeChange",
        )?,
        resume_after,
    })
}

impl Application {
    pub(super) async fn watch(
        &self,
        payload: Value,
        connection: DatabaseConnection,
    ) -> Result<Value> {
        let request = watch_request(read(&payload)?)?;
        let id = self.database.watch(connection, request).await?;
        Ok(json!({ "id": id, "state": "connected" }))
    }

    /// The realtime operations on a change stream, by its identifier; `None` for the
    /// engine's connections.
    pub(crate) async fn realtime_watch(
        &self,
        operation: Operation,
        payload: &Map<String, Value>,
    ) -> Result<Option<Value>> {
        let id = payload
            .get("id")
            .and_then(Value::as_str)
            .unwrap_or_default();
        if !id.starts_with(WATCH_PREFIX) {
            return Ok(None);
        }
        let answer = match operation {
            Operation::RealtimePoll => {
                let after = payload.get("after").and_then(Value::as_u64).unwrap_or(0);
                let events = self.database.watch_events(id, after).await?;
                serde_json::to_value(events)
                    .map_err(|error| Error::Infrastructure(error.to_string()))?
            }
            Operation::RealtimeClose => {
                self.database.watch_close(id).await?;
                json!({ "closed": true })
            }
            Operation::RealtimeSend => {
                return Err(Error::Validation(
                    "A change stream only receives: write to the collection to see changes".into(),
                ));
            }
            _ => return Ok(None),
        };
        Ok(Some(answer))
    }

    /// The engine's connections and the change streams, in one list.
    pub(crate) async fn realtime_list(&self, engine: Value) -> Result<Value> {
        let mut list = match engine {
            Value::Array(list) => list,
            _ => Vec::new(),
        };
        for watch in self.database.watches().await? {
            list.push(
                serde_json::to_value(watch)
                    .map_err(|error| Error::Infrastructure(error.to_string()))?,
            );
        }
        Ok(Value::Array(list))
    }
}
