//! Operations of a session: a statement or a catalog request started asynchronously, waited
//! for with `GetOperationStatus`, its columns read with `GetResultSetMetadata` and its rows a
//! page at a time with `FetchResults` (HiveServer2 keeps the cursor), cancelled with
//! `CancelOperation` and closed with `CloseOperation`.
use crate::{
    rows,
    session::{Session, check, failure},
    thrift::{Builder, Thrift},
};
use nexo_driver_sdk::{Column, DriverError, Result, Value, limits};
use std::time::Instant;

/// `TOperationState` of `TCLIService.thrift`.
mod state {
    pub const FINISHED: i32 = 2;
    pub const CANCELED: i32 = 3;
    pub const CLOSED: i32 = 4;
    pub const ERROR: i32 = 5;
    pub const TIMEDOUT: i32 = 8;
}
/// `FETCH_NEXT` of `TFetchOrientation`.
const FETCH_NEXT: i32 = 0;

/// An operation the server runs, by its handle.
#[derive(Clone, Debug)]
pub struct Operation {
    pub handle: Thrift,
    pub has_rows: bool,
}

impl Session {
    /// Starts a statement without waiting for it (`runAsync`), so it can be cancelled.
    pub async fn start(&self, sql: &str) -> Result<Operation> {
        let request = Builder::new()
            .set(1, self.handle()?)
            .set(2, Thrift::text(sql))
            .set(4, Thrift::Bool(true))
            .set(5, Thrift::I64(limits::STATEMENT.as_secs() as i64))
            .build();
        self.operation("ExecuteStatement", request).await
    }

    /// A request of the catalog (`GetSchemas`, `GetTables`, `GetColumns`, `GetFunctions`),
    /// its fields after the session handle.
    pub async fn catalog(&self, name: &str, fields: Vec<(i16, Thrift)>) -> Result<Operation> {
        let mut request = Builder::new().set(1, self.handle()?);
        for (id, value) in fields {
            request = request.set(id, value);
        }
        self.operation(name, request.build()).await
    }

    async fn operation(&self, name: &str, request: Thrift) -> Result<Operation> {
        let answer = self.call(name, request).await?;
        check(&answer)?;
        let handle = answer.field(2).cloned().ok_or_else(|| {
            DriverError::network(format!("HiveServer2 started nothing for {name}"))
        })?;
        let has_rows = handle.field(3).and_then(Thrift::bool).unwrap_or(true);
        Ok(Operation { handle, has_rows })
    }

    /// Waits for an operation to finish; its error, if it failed.
    pub async fn wait(&self, operation: &Operation) -> Result<()> {
        let started = Instant::now();
        let mut attempt = 0;
        loop {
            let request = Builder::new().set(1, operation.handle.clone()).build();
            let answer = self.call("GetOperationStatus", request).await?;
            check(&answer)?;
            match answer.field(2).and_then(Thrift::i32) {
                Some(state::FINISHED) => return Ok(()),
                Some(state::CANCELED | state::CLOSED) => {
                    return Err(DriverError::cancelled("The statement was cancelled"));
                }
                Some(state::ERROR | state::TIMEDOUT) => {
                    let message = answer
                        .field(5)
                        .and_then(Thrift::string)
                        .unwrap_or_else(|| "The statement failed".into());
                    return Err(failure(&message, answer.field(3).and_then(Thrift::string)));
                }
                _ => {}
            }
            if started.elapsed() > limits::STATEMENT {
                let _ = self.cancel(operation).await;
                return Err(DriverError::timeout(format!(
                    "The statement ran longer than {} seconds",
                    limits::STATEMENT.as_secs()
                )));
            }
            tokio::time::sleep(Session::backoff(attempt)).await;
            attempt += 1;
        }
    }

    /// The columns of an operation's results.
    pub async fn columns(&self, operation: &Operation) -> Result<Vec<Column>> {
        let request = Builder::new().set(1, operation.handle.clone()).build();
        let answer = self.call("GetResultSetMetadata", request).await?;
        check(&answer)?;
        Ok(answer.field(2).map(rows::columns).unwrap_or_default())
    }

    /// The next `count` rows; whether more follow.
    pub async fn fetch(
        &self,
        operation: &Operation,
        columns: &[Column],
        count: usize,
    ) -> Result<(Vec<Vec<Value>>, bool)> {
        let request = Builder::new()
            .set(1, operation.handle.clone())
            .set(2, Thrift::I32(FETCH_NEXT))
            .set(3, Thrift::I64(count as i64))
            .build();
        let answer = self.call("FetchResults", request).await?;
        check(&answer)?;
        let found = answer
            .field(3)
            .map(|set| rows::rows(set, columns))
            .unwrap_or_default();
        // `hasMoreRows` is not reliable in every version: a full page means there may be more.
        let more = answer.field(2).and_then(Thrift::bool).unwrap_or(false) || found.len() >= count;
        Ok((found, more))
    }

    pub async fn cancel(&self, operation: &Operation) -> Result<()> {
        let request = Builder::new().set(1, operation.handle.clone()).build();
        check(&self.call("CancelOperation", request).await?)
    }

    pub async fn close_operation(&self, operation: &Operation) {
        let request = Builder::new().set(1, operation.handle.clone()).build();
        let _ = self.call("CloseOperation", request).await;
    }

    /// Runs a catalog request or a statement to its end and reads all its rows (at most
    /// `limit`), for the tree and the sheets.
    pub async fn read_all(
        &self,
        operation: Operation,
        limit: usize,
    ) -> Result<(Vec<Column>, Vec<Vec<Value>>)> {
        self.wait(&operation).await?;
        let columns = self.columns(&operation).await?;
        let mut all = Vec::new();
        loop {
            let (found, more) = self.fetch(&operation, &columns, 1000).await?;
            let empty = found.is_empty();
            all.extend(found);
            if !more || empty || all.len() >= limit {
                break;
            }
        }
        all.truncate(limit);
        self.close_operation(&operation).await;
        Ok((columns, all))
    }
}
