//! The `document` extension: each method of the application's document database port,
//! read from its message and answered on the connection it names.
use super::*;
use nexo_driver_sdk::document::{
    AggregateRequest, AggregateWrite, CollectionChange, CollectionName, CountRequest,
    DatabaseName, EventsRequest, ExplainRequest, FindRequest, ImportRequest, IndexChange,
    MoreRequest, Named, On, ProfileRequest, ProfiledRequest, WatchRequest, WriteRequest, methods,
};
use serde::{Serialize, de::DeserializeOwned};
use serde_json::Value as Json;

fn read<T: DeserializeOwned>(params: Json) -> nexo_driver_sdk::Result<T> {
    serde_json::from_value(params)
        .map_err(|error| DriverError::invalid(format!("Invalid request: {error}")))
}
fn answer<T: Serialize>(value: Result<T>) -> nexo_driver_sdk::Result<Json> {
    serde_json::to_value(value?).map_err(|error| DriverError::internal(error.to_string()))
}

impl MongoDriver {
    pub(super) async fn answer(
        &self,
        link: &HostLink,
        method: &str,
        params: Json,
    ) -> nexo_driver_sdk::Result<Json> {
        match method {
            methods::REPORT => {
                let on: On<()> = read(params)?;
                answer(within(self.report(link, &on.connection)).await)
            }
            methods::DATABASES => {
                let on: On<()> = read(params)?;
                let (client, default_database) = self.client(&on.connection)?;
                answer(within(browse::databases(&client, default_database)).await)
            }
            methods::COLLECTIONS => {
                let on: On<DatabaseName> = read(params)?;
                let (client, _) = self.client(&on.connection)?;
                answer(within(browse::collections(&client, &on.request.database)).await)
            }
            methods::STATS => {
                let on: On<CollectionName> = read(params)?;
                let (client, _) = self.client(&on.connection)?;
                let CollectionName {
                    database,
                    collection,
                } = on.request;
                answer(within(browse::stats(&client, &database, &collection)).await)
            }
            methods::FIND => {
                let on: On<FindRequest> = read(params)?;
                let (client, _) = self.client(&on.connection)?;
                answer(query::find(self, client, on.request).await)
            }
            methods::MORE => {
                let on: On<MoreRequest> = read(params)?;
                let MoreRequest {
                    cursor,
                    id,
                    page_size,
                } = on.request;
                answer(query::more(self, &cursor, &id, page_size).await)
            }
            methods::COUNT => {
                let on: On<CountRequest> = read(params)?;
                let (client, _) = self.client(&on.connection)?;
                answer(query::count(self, client, on.request).await)
            }
            methods::AGGREGATE => {
                let on: On<AggregateRequest> = read(params)?;
                let (client, _) = self.client(&on.connection)?;
                answer(query::aggregate(self, client, on.request).await)
            }
            methods::AGGREGATE_WRITE => {
                let on: On<AggregateWrite> = read(params)?;
                let (client, _) = self.client(&on.connection)?;
                answer(query::aggregate_write(self, client, on.request).await)
            }
            methods::CANCEL => {
                let on: On<Named> = read(params)?;
                answer(Ok(query::cancel(self, &on.request.id).await))
            }
            methods::CLOSE => {
                let on: On<Named> = read(params)?;
                // Dropping a cursor tells the server to close it.
                let closed = self.cursors.lock().map(|mut cursors| {
                    cursors.remove(&on.request.id);
                });
                answer(closed.map_err(|_| Error::Infrastructure("cursor list unavailable".into())))
            }
            methods::WRITE => {
                let on: On<WriteRequest> = read(params)?;
                let (client, _) = self.client(&on.connection)?;
                let WriteRequest { target, write } = on.request;
                answer(within(write::write(&client, target, write)).await)
            }
            methods::IMPORT => {
                let on: On<ImportRequest> = read(params)?;
                let (client, _) = self.client(&on.connection)?;
                let ImportRequest { target, batch } = on.request;
                answer(within(write::import(&client, target, batch)).await)
            }
            methods::CHANGE => {
                let on: On<CollectionChange> = read(params)?;
                let (client, _) = self.client(&on.connection)?;
                answer(within(write::change(&client, on.request)).await)
            }
            methods::INDEXES => {
                let on: On<CollectionName> = read(params)?;
                let (client, _) = self.client(&on.connection)?;
                let CollectionName {
                    database,
                    collection,
                } = on.request;
                answer(within(indexes::list(&client, &database, &collection)).await)
            }
            methods::INDEX => {
                let on: On<IndexChange> = read(params)?;
                let (client, _) = self.client(&on.connection)?;
                answer(within(indexes::change(&client, on.request)).await)
            }
            methods::EXPLAIN => {
                let on: On<ExplainRequest> = read(params)?;
                let (client, _) = self.client(&on.connection)?;
                answer(explain::explain(self, client, on.request).await)
            }
            methods::PROFILE => {
                let on: On<ProfileRequest> = read(params)?;
                let (client, _) = self.client(&on.connection)?;
                let ProfileRequest { database, set } = on.request;
                answer(within(profiler::profile(&client, &database, set)).await)
            }
            methods::PROFILED => {
                let on: On<ProfiledRequest> = read(params)?;
                let (client, _) = self.client(&on.connection)?;
                let ProfiledRequest {
                    database,
                    collection,
                    limit,
                } = on.request;
                let entries = profiler::entries(&client, &database, collection.as_deref(), limit);
                answer(within(entries).await)
            }
            methods::WATCH => {
                let on: On<WatchRequest> = read(params)?;
                let (client, _) = self.client(&on.connection)?;
                answer(watch::watch(self, client, on.request).await)
            }
            methods::WATCH_EVENTS => {
                let on: On<EventsRequest> = read(params)?;
                answer(watch::events(self, &on.request.id, on.request.after))
            }
            methods::WATCH_CLOSE => {
                let on: On<Named> = read(params)?;
                answer(watch::close(self, &on.request.id))
            }
            methods::WATCHES => {
                let _: On<()> = read(params)?;
                answer(Ok(watch::list(self)))
            }
            other => Err(DriverError::unsupported(format!(
                "The MongoDB driver does not answer {other}"
            ))),
        }
    }
}
