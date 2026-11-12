//! Change streams: a collection, a database or the whole deployment watched in the
//! background, each change kept in a log the realtime panel reads by polling. Opening one
//! waits for the server, so a standalone server (which has no change streams) or a wrong
//! pipeline is answered at once. Afterwards, when the connection drops, the stream opens
//! again after the last change it read, waiting longer each time, up to `RETRIES` times.
mod follow;
mod log;

use crate::{MongoAdapter, browse::check_name, errors, limits, query::document};
use bson::{Bson, Document};
use follow::follow;
use log::Log;
use mongodb::{
    Client,
    change_stream::{ChangeStream, event::ResumeToken},
    error::{Error as DriverError, ErrorKind},
    options::{FullDocumentBeforeChangeType, FullDocumentType},
};
use nexo_application::ports::{WATCH_PREFIX, WatchEvents, WatchRequest, WatchSummary};
use nexo_domain::{Error, Result};
use serde_json::{Value, json};
use std::{
    sync::{Arc, Mutex, PoisonError},
    time::Duration,
};

/// Change streams open at once, as many as the engine's realtime connections.
pub const MAX_OPEN: usize = 16;
/// Times a dropped change stream is opened again in a row before it gives up.
const RETRIES: u32 = 10;
/// How long the server waits for a change before answering an empty batch.
const MAX_AWAIT: Duration = Duration::from_secs(1);

/// A change stream running in the background.
pub struct Watching {
    label: String,
    log: Arc<Mutex<Log>>,
    task: tokio::task::JoinHandle<()>,
}

/// What a change stream reads: the target, its stages and its options.
#[derive(Clone)]
struct Plan {
    request: WatchRequest,
    pipeline: Vec<Document>,
}

fn lock(log: &Mutex<Log>) -> std::sync::MutexGuard<'_, Log> {
    log.lock().unwrap_or_else(PoisonError::into_inner)
}

/// A resume token from what was typed: `{_data: …}`.
fn resume_token(value: Value) -> Result<ResumeToken> {
    let token = document(Some(value), "resume token")?.unwrap_or_default();
    bson::deserialize_from_bson(Bson::Document(token))
        .map_err(|error| Error::Validation(format!("Invalid resume token: {error}")))
}

/// What a change stream watches, as the realtime panel lists it.
fn label(request: &WatchRequest) -> String {
    match (&request.database, &request.collection) {
        (Some(database), Some(collection)) => format!("{database}.{collection}"),
        (Some(database), None) => database.clone(),
        _ => "deployment".into(),
    }
}

/// Opens the change stream of a plan, after `token` when there is one.
async fn open(
    client: &Client,
    plan: &Plan,
    token: Option<ResumeToken>,
) -> std::result::Result<ChangeStream<Document>, DriverError> {
    let request = &plan.request;
    // The database and the collection watched live as long as the watch that borrows them.
    let database = request.database.as_ref().map(|name| client.database(name));
    let collection = database
        .as_ref()
        .zip(request.collection.as_ref())
        .map(|(database, name)| database.collection::<Document>(name));
    let watch = match (&collection, &database) {
        (Some(collection), _) => collection.watch(),
        (None, Some(database)) => database.watch(),
        _ => client.watch(),
    };
    let mut watch = watch
        .pipeline(plan.pipeline.clone())
        .max_await_time(MAX_AWAIT);
    match request.full_document.as_deref() {
        Some("updateLookup") => watch = watch.full_document(FullDocumentType::UpdateLookup),
        Some("whenAvailable") => watch = watch.full_document(FullDocumentType::WhenAvailable),
        Some("required") => watch = watch.full_document(FullDocumentType::Required),
        _ => {}
    }
    match request.full_document_before_change.as_deref() {
        Some("whenAvailable") => {
            watch = watch.full_document_before_change(FullDocumentBeforeChangeType::WhenAvailable)
        }
        Some("required") => {
            watch = watch.full_document_before_change(FullDocumentBeforeChangeType::Required)
        }
        _ => {}
    }
    Ok(watch.resume_after(token).await?.with_type::<Document>())
}

/// A driver error, with what to do about the ones change streams have of their own.
fn explain(error: DriverError) -> Error {
    if let ErrorKind::Command(command) = error.kind.as_ref() {
        match command.code {
            40573 => {
                return Error::Validation(
                    "Change streams need a replica set or a sharded cluster, and this server is a standalone mongod. A replica set of one member is enough: start mongod with --replSet and run rs.initiate() once".into(),
                );
            }
            286 | 280 => {
                return Error::Validation(
                    "The server no longer has the change of this resume token in its oplog: watch from now instead".into(),
                );
            }
            _ => {}
        }
    }
    errors::driver(error)
}

pub async fn watch(
    adapter: &MongoAdapter,
    client: Client,
    request: WatchRequest,
) -> Result<String> {
    let open_now = {
        let mut watches = adapter
            .watches
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        watches.retain(|_, watching| {
            let log = lock(&watching.log);
            log.open() || !log.expired()
        });
        watches.values().filter(|w| lock(&w.log).open()).count()
    };
    if open_now >= MAX_OPEN {
        return Err(Error::Validation(
            "Connection limit reached; close a connection first".into(),
        ));
    }
    if let Some(database) = &request.database {
        check_name(database, "database")?;
    }
    if let Some(collection) = &request.collection {
        check_name(collection, "collection")?;
    }
    let pipeline = request
        .pipeline
        .iter()
        .map(|stage| {
            document(Some(stage.clone()), "pipeline stage")?
                .ok_or_else(|| Error::Validation("A pipeline stage is a document".into()))
        })
        .collect::<Result<Vec<_>>>()?;
    let token = request.resume_after.clone().map(resume_token).transpose()?;
    let plan = Plan { request, pipeline };
    let stream = tokio::time::timeout(limits::CONNECT, open(&client, &plan, token))
        .await
        .map_err(|_| Error::Validation("The server did not open the change stream in time".into()))?
        .map_err(explain)?;
    let label = label(&plan.request);
    let log = Arc::new(Mutex::new(Log::new()));
    lock(&log).emit("open", json!({ "watching": label }));
    let task = tokio::spawn(follow(client, plan, stream, log.clone()));
    let id = format!("{WATCH_PREFIX}{}", uuid::Uuid::new_v4());
    adapter
        .watches
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .insert(id.clone(), Watching { label, log, task });
    Ok(id)
}

pub fn events(adapter: &MongoAdapter, id: &str, after: u64) -> Result<WatchEvents> {
    let watches = adapter
        .watches
        .lock()
        .unwrap_or_else(PoisonError::into_inner);
    let watching = watches
        .get(id)
        .ok_or_else(|| Error::Validation("Connection not found".into()))?;
    let log = lock(&watching.log);
    Ok(WatchEvents {
        id: id.to_string(),
        state: log.state().to_string(),
        events: log.after(after),
    })
}

pub fn close(adapter: &MongoAdapter, id: &str) -> Result<()> {
    let watching = adapter
        .watches
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .remove(id)
        .ok_or_else(|| Error::Validation("Connection not found".into()))?;
    // Dropping the stream with its task closes the cursor on the server.
    watching.task.abort();
    Ok(())
}

pub fn list(adapter: &MongoAdapter) -> Vec<WatchSummary> {
    let mut watches = adapter
        .watches
        .lock()
        .unwrap_or_else(PoisonError::into_inner);
    watches.retain(|_, watching| {
        let log = lock(&watching.log);
        log.open() || !log.expired()
    });
    watches
        .iter()
        .map(|(id, watching)| WatchSummary {
            id: id.clone(),
            protocol: "mongodb".into(),
            url: watching.label.clone(),
            state: lock(&watching.log).state().to_string(),
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_resume_tokens_and_names_what_is_watched() {
        let token = resume_token(json!({ "_data": "8263A1" })).unwrap();
        assert_eq!(
            bson::serialize_to_bson(&token).unwrap(),
            Bson::Document(bson::doc! { "_data": "8263A1" })
        );
        assert!(resume_token(json!("x")).is_err());
        let request = |database: Option<&str>, collection: Option<&str>| WatchRequest {
            database: database.map(String::from),
            collection: collection.map(String::from),
            ..Default::default()
        };
        assert_eq!(label(&request(Some("shop"), Some("orders"))), "shop.orders");
        assert_eq!(label(&request(Some("shop"), None)), "shop");
        assert_eq!(label(&request(None, None)), "deployment");
    }
}
