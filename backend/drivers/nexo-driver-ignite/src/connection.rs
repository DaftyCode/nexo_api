//! A connection of the driver: its client, its settings, the cursors it keeps, the
//! statements running (to cancel them) and its transaction. In manual mode a transaction
//! begins before the next statement, as Ignite's JDBC driver does with auto-commit off.
use crate::{
    client::Client,
    sql::{self, Answer, Statement},
    values::Field,
};
use nexo_driver_sdk::{
    DriverError, Result, Value, limits,
    statements::{TransactionAction, TransactionState},
};
use std::{
    collections::{HashMap, VecDeque},
    sync::{Arc, Mutex},
};

/// Rows a list of the tree or a sheet reads at most.
pub const NODES: usize = 10_000;
/// Rows in each page of a catalog query.
const CATALOG_PAGE: usize = 1000;

/// An open result: the server's cursor while it has more, and the rows read but not sent.
pub struct Cursor {
    pub resource: Option<i64>,
    pub fields: Vec<Field>,
    pub rows: VecDeque<Vec<Value>>,
}

#[derive(Debug, Default)]
struct Transaction {
    manual: bool,
    open: Option<i64>,
}

pub struct Connection {
    pub client: Arc<Client>,
    pub schema: Option<String>,
    pub time_zone: String,
    pub cursors: Mutex<HashMap<String, Cursor>>,
    /// The request of each statement running, by the name the editor gave it.
    pub running: Mutex<HashMap<String, i64>>,
    transaction: tokio::sync::Mutex<Transaction>,
}

impl Connection {
    pub fn new(client: Client, schema: Option<String>, time_zone: String) -> Self {
        let client = Arc::new(client);
        client.keep_alive();
        Self {
            client,
            schema,
            time_zone,
            cursors: Mutex::default(),
            running: Mutex::default(),
            transaction: tokio::sync::Mutex::default(),
        }
    }

    fn statement<'a>(
        &'a self,
        sql: &'a str,
        args: &'a [Value],
        page: usize,
        transaction: Option<i64>,
    ) -> Statement<'a> {
        Statement {
            sql,
            args,
            schema: self.schema.as_deref(),
            page,
            timeout_ms: limits::STATEMENT.as_millis() as u64,
            time_zone: &self.time_zone,
            transaction,
        }
    }

    /// Every row of a query of the catalog, up to [`NODES`], outside any transaction.
    pub async fn query(&self, sql: &str, args: &[Value]) -> Result<Vec<Vec<Value>>> {
        let id = self.client.reserve();
        let statement = self.statement(sql, args, CATALOG_PAGE, None);
        let answer = sql::execute(&self.client, id, &statement).await?;
        let mut rows = answer.rows;
        let mut cursor = answer.cursor;
        while let Some(open) = cursor {
            if rows.len() >= NODES {
                sql::close(&self.client, open).await?;
                break;
            }
            let (page, more) = sql::next_page(&self.client, open, &answer.fields).await?;
            rows.extend(page);
            cursor = more.then_some(open);
        }
        rows.truncate(NODES);
        Ok(rows)
    }

    /// Runs a statement of the editor, in the open transaction in manual mode.
    pub async fn run(&self, name: &str, sql: &str, args: &[Value], page: usize) -> Result<Answer> {
        let transaction = {
            let mut state = self.transaction.lock().await;
            if state.manual && state.open.is_none() {
                state.open = Some(sql::begin(&self.client).await?);
            }
            state.open
        };
        let id = self.client.reserve();
        self.running.lock().unwrap().insert(name.to_owned(), id);
        let statement = self.statement(sql, args, page, transaction);
        let answer = sql::execute(&self.client, id, &statement).await;
        self.running.lock().unwrap().remove(name);
        answer
    }

    /// Cancels the statement the editor named, if it still runs.
    pub async fn cancel(&self, name: &str) -> Result<()> {
        let running = self.running.lock().unwrap().get(name).copied();
        match running {
            Some(id) => sql::cancel(&self.client, id).await,
            None => Ok(()),
        }
    }

    /// Up to `count` rows of a cursor, reading the server's pages it needs.
    pub async fn take(&self, cursor: &mut Cursor, count: usize) -> Result<Vec<Vec<Value>>> {
        while cursor.rows.len() < count {
            let Some(resource) = cursor.resource else {
                break;
            };
            let (page, more) = sql::next_page(&self.client, resource, &cursor.fields).await?;
            cursor.rows.extend(page);
            if !more {
                cursor.resource = None;
            }
        }
        let count = count.min(cursor.rows.len());
        Ok(cursor.rows.drain(..count).collect())
    }

    /// Closes a cursor on the server, if it is still open there.
    pub async fn close(&self, cursor: &Cursor) {
        if let Some(resource) = cursor.resource {
            let _ = sql::close(&self.client, resource).await;
        }
    }

    pub async fn transaction(&self, action: TransactionAction) -> Result<TransactionState> {
        let mut state = self.transaction.lock().await;
        match action {
            TransactionAction::Status => {}
            TransactionAction::Begin if state.open.is_some() => {
                return Err(DriverError::invalid("A transaction is already open"));
            }
            TransactionAction::Begin => state.open = Some(sql::begin(&self.client).await?),
            TransactionAction::Commit | TransactionAction::Rollback | TransactionAction::Auto => {
                if let Some(open) = state.open.take() {
                    let commit = action != TransactionAction::Rollback;
                    sql::finish(&self.client, open, commit).await?;
                }
                if action == TransactionAction::Auto {
                    state.manual = false;
                }
            }
            TransactionAction::Manual => state.manual = true,
        }
        Ok(TransactionState {
            auto_commit: !state.manual,
            open: state.open.is_some(),
        })
    }

    pub async fn close_all(&self) {
        let open = self.transaction.lock().await.open.take();
        if let Some(open) = open {
            let _ = sql::finish(&self.client, open, false).await;
        }
        self.client.close().await;
    }
}
