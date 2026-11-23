//! The document database port: each method of the application, one method of the driver.
use super::{Documents, answers, convert};
use async_trait::async_trait;
use nexo_application::ports::{
    AggregateRequest, AggregateWrite, CollectionChange, CollectionStats, CollectionSummary,
    ConnectionReport, CountRequest, DatabaseConnection, DatabaseSummary, DocumentDatabase,
    DocumentPage, DocumentWrite, ExplainRequest, FindRequest, ImportBatch, ImportResult,
    IndexChange, IndexDetail, ProfileEntry, ProfileStatus, WatchEvents, WatchRequest, WatchSummary,
    WriteResult, WriteTarget,
};
use nexo_domain::{Error, Result};
use nexo_driver_sdk::document::{self as wire, methods};
use serde_json::{Value, json};

impl Documents {
    /// A query that may be cancelled while it runs: the driver connection that runs it is
    /// known by its id until it ends, and the cursor it leaves open from then on.
    async fn paged(
        &self,
        connection: &DatabaseConnection,
        id: &str,
        method: &str,
        request: impl serde::Serialize + Sync,
    ) -> Result<DocumentPage> {
        let session = self.session(connection).await?;
        self.routes.learn(id, &session);
        let page: Result<wire::DocumentPage> = self.call(&session, method, request).await;
        self.routes.forget(id);
        let page = page?;
        if let Some(cursor) = &page.cursor {
            self.routes.learn(cursor, &session);
        }
        Ok(answers::page(page))
    }

    /// Something else that may be cancelled while it runs.
    async fn running<R: serde::de::DeserializeOwned>(
        &self,
        connection: &DatabaseConnection,
        id: &str,
        method: &str,
        request: impl serde::Serialize + Sync,
    ) -> Result<R> {
        let session = self.session(connection).await?;
        self.routes.learn(id, &session);
        let answer = self.call(&session, method, request).await;
        self.routes.forget(id);
        answer
    }
}

/// What the driver answers for a cursor it no longer has.
fn closed_cursor() -> Error {
    Error::Validation("These results are no longer open: run the query again".into())
}

#[async_trait]
impl DocumentDatabase for Documents {
    async fn test(&self, connection: DatabaseConnection) -> Result<ConnectionReport> {
        let network = self.host.network();
        let proxy = network.socks_proxy(&connection.route).await?;
        let check_members = network.restrictive() || !connection.secret_hosts.is_empty();
        let name = format!("mongo-test-{}", uuid::Uuid::new_v4().simple());
        self.open(&name, &connection, proxy, check_members).await?;
        let report = self.call(&name, methods::REPORT, ()).await;
        let _ = self.host.disconnect(&name).await;
        report.map(answers::report)
    }
    async fn databases(&self, connection: DatabaseConnection) -> Result<Vec<DatabaseSummary>> {
        let found: Vec<wire::DatabaseSummary> =
            self.on(&connection, methods::DATABASES, ()).await?;
        Ok(found.into_iter().map(answers::database).collect())
    }
    async fn collections(
        &self,
        connection: DatabaseConnection,
        database: &str,
    ) -> Result<Vec<CollectionSummary>> {
        let request = json!({"database": database});
        let found: Vec<wire::CollectionSummary> =
            self.on(&connection, methods::COLLECTIONS, request).await?;
        Ok(found.into_iter().map(answers::collection).collect())
    }
    async fn stats(
        &self,
        connection: DatabaseConnection,
        database: &str,
        collection: &str,
    ) -> Result<CollectionStats> {
        let request = json!({"database": database, "collection": collection});
        let stats = self.on(&connection, methods::STATS, request).await?;
        Ok(answers::stats(stats))
    }
    async fn find(
        &self,
        connection: DatabaseConnection,
        request: FindRequest,
    ) -> Result<DocumentPage> {
        let id = request.id.clone();
        let request = convert::find(request);
        self.paged(&connection, &id, methods::FIND, request).await
    }
    async fn more(&self, cursor: &str, id: &str, page_size: u64) -> Result<DocumentPage> {
        let session = self.holder(cursor).await.ok_or_else(closed_cursor)?;
        self.routes.learn(id, &session);
        let request = wire::MoreRequest {
            cursor: cursor.to_owned(),
            id: id.to_owned(),
            page_size,
        };
        let page: Result<wire::DocumentPage> = self.call(&session, methods::MORE, request).await;
        self.routes.forget(id);
        self.routes.forget(cursor);
        let page = page?;
        if let Some(next) = &page.cursor {
            self.routes.learn(next, &session);
        }
        Ok(answers::page(page))
    }
    async fn count(&self, connection: DatabaseConnection, request: CountRequest) -> Result<u64> {
        let id = request.id.clone();
        let request = convert::count(request);
        self.running(&connection, &id, methods::COUNT, request)
            .await
    }
    async fn aggregate(
        &self,
        connection: DatabaseConnection,
        request: AggregateRequest,
    ) -> Result<DocumentPage> {
        let id = request.id.clone();
        let request = convert::aggregate(request);
        self.paged(&connection, &id, methods::AGGREGATE, request)
            .await
    }
    async fn aggregate_write(
        &self,
        connection: DatabaseConnection,
        request: AggregateWrite,
    ) -> Result<u64> {
        let id = request.id.clone();
        let request = convert::aggregate_write(request);
        self.running(&connection, &id, methods::AGGREGATE_WRITE, request)
            .await
    }
    async fn cancel(&self, id: &str) -> Result<bool> {
        let Some(session) = self.routes.of(id) else {
            return Ok(false);
        };
        self.call(&session, methods::CANCEL, json!({"id": id}))
            .await
    }
    async fn close(&self, cursor: &str) -> Result<()> {
        let Some(session) = self.routes.of(cursor) else {
            return Ok(());
        };
        self.routes.forget(cursor);
        if !self.host.is_open(&session).await {
            return Ok(());
        }
        self.call(&session, methods::CLOSE, json!({"id": cursor}))
            .await
    }
    async fn write(
        &self,
        connection: DatabaseConnection,
        target: WriteTarget,
        write: DocumentWrite,
    ) -> Result<WriteResult> {
        let request = wire::WriteRequest {
            target: convert::target(target),
            write: convert::write(write),
        };
        let written = self.on(&connection, methods::WRITE, request).await?;
        Ok(convert::written(written))
    }
    async fn change(&self, connection: DatabaseConnection, change: CollectionChange) -> Result<()> {
        let change = convert::collection_change(change);
        self.on(&connection, methods::CHANGE, change).await
    }
    async fn indexes(
        &self,
        connection: DatabaseConnection,
        database: &str,
        collection: &str,
    ) -> Result<Vec<IndexDetail>> {
        let request = json!({"database": database, "collection": collection});
        let found: Vec<wire::IndexDetail> = self.on(&connection, methods::INDEXES, request).await?;
        Ok(found.into_iter().map(answers::index).collect())
    }
    async fn index(&self, connection: DatabaseConnection, change: IndexChange) -> Result<()> {
        let change = convert::index_change(change);
        self.on(&connection, methods::INDEX, change).await
    }
    async fn explain(
        &self,
        connection: DatabaseConnection,
        request: ExplainRequest,
    ) -> Result<Value> {
        let id = request.id.clone();
        let request = convert::explain(request);
        self.running(&connection, &id, methods::EXPLAIN, request)
            .await
    }
    async fn profile(
        &self,
        connection: DatabaseConnection,
        database: &str,
        set: Option<(i64, Option<i64>)>,
    ) -> Result<ProfileStatus> {
        let request = wire::ProfileRequest {
            database: database.to_owned(),
            set,
        };
        let status = self.on(&connection, methods::PROFILE, request).await?;
        Ok(answers::profile(status))
    }
    async fn profiled(
        &self,
        connection: DatabaseConnection,
        database: &str,
        collection: Option<&str>,
        limit: u64,
    ) -> Result<Vec<ProfileEntry>> {
        let request = wire::ProfiledRequest {
            database: database.to_owned(),
            collection: collection.map(str::to_owned),
            limit,
        };
        let entries: Vec<wire::ProfileEntry> =
            self.on(&connection, methods::PROFILED, request).await?;
        Ok(entries.into_iter().map(answers::profiled).collect())
    }
    async fn watch(&self, connection: DatabaseConnection, request: WatchRequest) -> Result<String> {
        let session = self.session(&connection).await?;
        let request = convert::watch(request);
        let id: String = self.call(&session, methods::WATCH, request).await?;
        // A change stream runs until it is closed: its connection is not closed for being
        // unused meanwhile.
        if self.routes.watch(&id, &session) {
            self.host.hold(&session, true);
        }
        Ok(id)
    }
    async fn watch_events(&self, id: &str, after: u64) -> Result<WatchEvents> {
        let session = self
            .holder(id)
            .await
            .ok_or_else(|| Error::Validation("Connection not found".into()))?;
        let request = wire::EventsRequest {
            id: id.to_owned(),
            after,
        };
        let events = self.call(&session, methods::WATCH_EVENTS, request).await?;
        Ok(answers::events(events))
    }
    async fn watch_close(&self, id: &str) -> Result<()> {
        let session = self
            .holder(id)
            .await
            .ok_or_else(|| Error::Validation("Connection not found".into()))?;
        let closed = self
            .call(&session, methods::WATCH_CLOSE, json!({"id": id}))
            .await;
        if let Some(last) = self.routes.unwatch(id) {
            self.host.hold(&last, false);
        }
        closed
    }
    async fn watches(&self) -> Result<Vec<WatchSummary>> {
        let Some(session) = self.holder("").await else {
            return Ok(Vec::new());
        };
        let found: Vec<wire::WatchSummary> = self.call(&session, methods::WATCHES, ()).await?;
        Ok(found.into_iter().map(answers::watching).collect())
    }
    async fn import(
        &self,
        connection: DatabaseConnection,
        target: WriteTarget,
        batch: ImportBatch,
    ) -> Result<ImportResult> {
        let request = wire::ImportRequest {
            target: convert::target(target),
            batch: convert::batch(batch),
        };
        let imported = self.on(&connection, methods::IMPORT, request).await?;
        Ok(answers::imported(imported))
    }
}
