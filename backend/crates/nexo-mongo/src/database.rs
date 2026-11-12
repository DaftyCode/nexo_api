//! The `DocumentDatabase` port, implemented with the official driver.
use super::*;

#[async_trait]
impl DocumentDatabase for MongoAdapter {
    async fn test(&self, connection: DatabaseConnection) -> Result<ConnectionReport> {
        within(self.run_test(connection)).await
    }
    async fn databases(&self, connection: DatabaseConnection) -> Result<Vec<DatabaseSummary>> {
        within(async {
            let (client, default_database) = self.client(&connection).await?;
            browse::databases(&client, default_database).await
        })
        .await
    }
    async fn collections(
        &self,
        connection: DatabaseConnection,
        database: &str,
    ) -> Result<Vec<CollectionSummary>> {
        within(async {
            let (client, _) = self.client(&connection).await?;
            browse::collections(&client, database).await
        })
        .await
    }
    async fn stats(
        &self,
        connection: DatabaseConnection,
        database: &str,
        collection: &str,
    ) -> Result<CollectionStats> {
        within(async {
            let (client, _) = self.client(&connection).await?;
            browse::stats(&client, database, collection).await
        })
        .await
    }
    async fn find(
        &self,
        connection: DatabaseConnection,
        request: FindRequest,
    ) -> Result<DocumentPage> {
        let (client, _) = within(self.client(&connection)).await?;
        query::find(self, client, request).await
    }
    async fn aggregate(
        &self,
        connection: DatabaseConnection,
        request: AggregateRequest,
    ) -> Result<DocumentPage> {
        let (client, _) = within(self.client(&connection)).await?;
        query::aggregate(self, client, request).await
    }
    async fn aggregate_write(
        &self,
        connection: DatabaseConnection,
        request: AggregateWrite,
    ) -> Result<u64> {
        let (client, _) = within(self.client(&connection)).await?;
        query::aggregate_write(self, client, request).await
    }
    async fn more(&self, cursor: &str, id: &str, page_size: u64) -> Result<DocumentPage> {
        query::more(self, cursor, id, page_size).await
    }
    async fn count(&self, connection: DatabaseConnection, request: CountRequest) -> Result<u64> {
        let (client, _) = within(self.client(&connection)).await?;
        query::count(self, client, request).await
    }
    async fn cancel(&self, id: &str) -> Result<bool> {
        Ok(query::cancel(self, id).await)
    }
    async fn write(
        &self,
        connection: DatabaseConnection,
        target: WriteTarget,
        write: DocumentWrite,
    ) -> Result<WriteResult> {
        within(async {
            let (client, _) = self.client(&connection).await?;
            write::write(&client, target, write).await
        })
        .await
    }
    async fn import(
        &self,
        connection: DatabaseConnection,
        target: WriteTarget,
        batch: ImportBatch,
    ) -> Result<ImportResult> {
        within(async {
            let (client, _) = self.client(&connection).await?;
            write::import(&client, target, batch).await
        })
        .await
    }
    async fn change(&self, connection: DatabaseConnection, change: CollectionChange) -> Result<()> {
        within(async {
            let (client, _) = self.client(&connection).await?;
            write::change(&client, change).await
        })
        .await
    }
    async fn close(&self, cursor: &str) -> Result<()> {
        // Dropping a cursor tells the server to close it.
        self.cursors
            .lock()
            .map_err(|_| Error::Infrastructure("cursor list unavailable".into()))?
            .remove(cursor);
        Ok(())
    }
    async fn indexes(
        &self,
        connection: DatabaseConnection,
        database: &str,
        collection: &str,
    ) -> Result<Vec<IndexDetail>> {
        within(async {
            let (client, _) = self.client(&connection).await?;
            indexes::list(&client, database, collection).await
        })
        .await
    }
    async fn index(&self, connection: DatabaseConnection, change: IndexChange) -> Result<()> {
        within(async {
            let (client, _) = self.client(&connection).await?;
            indexes::change(&client, change).await
        })
        .await
    }
    async fn explain(
        &self,
        connection: DatabaseConnection,
        request: ExplainRequest,
    ) -> Result<serde_json::Value> {
        let (client, _) = within(self.client(&connection)).await?;
        explain::explain(self, client, request).await
    }
    async fn profile(
        &self,
        connection: DatabaseConnection,
        database: &str,
        set: Option<(i64, Option<i64>)>,
    ) -> Result<ProfileStatus> {
        within(async {
            let (client, _) = self.client(&connection).await?;
            profiler::profile(&client, database, set).await
        })
        .await
    }
    async fn profiled(
        &self,
        connection: DatabaseConnection,
        database: &str,
        collection: Option<&str>,
        limit: u64,
    ) -> Result<Vec<ProfileEntry>> {
        within(async {
            let (client, _) = self.client(&connection).await?;
            profiler::entries(&client, database, collection, limit).await
        })
        .await
    }
}
