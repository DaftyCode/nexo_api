//! The driver served over the real protocol, as Nexo's host serves it, on a SQLite file each
//! test makes: no server is needed, so these tests always run.
#![allow(dead_code)]
use async_trait::async_trait;
use nexo_driver_sdk::{
    Client, DriverError, Handler, Peer, Result, Value,
    protocol::ConnectParams,
    statements::{ExecuteParams, ExecuteResult},
};
use nexo_driver_sqlite::SqliteDriver;
use serde_json::Value as Json;
use std::path::{Path, PathBuf};

/// A host that answers nothing: a SQLite driver reaches no network, so it never asks.
struct Host;
#[async_trait]
impl Handler for Host {
    async fn request(&self, method: &str, _params: Json) -> Result<Json> {
        Err(DriverError::unsupported(format!(
            "A SQLite driver asked the host for {method}"
        )))
    }
}

/// The driver behind the protocol, in memory.
pub fn driver() -> Client {
    let (to_driver, from_host) = tokio::io::duplex(1 << 20);
    let (to_host, from_driver) = tokio::io::duplex(1 << 20);
    tokio::spawn(nexo_driver_sdk::serve(
        SqliteDriver::default(),
        from_host,
        to_host,
    ));
    let (peer, _) = Peer::start(from_driver, to_driver, |_| Host);
    Client::new(peer)
}

/// A folder of its own for a test, removed when it ends.
pub struct Folder(pub PathBuf);
impl Folder {
    pub fn new(test: &str) -> Self {
        let path = std::env::temp_dir().join(format!(
            "nexo-sqlite-{test}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&path).unwrap();
        Self(path)
    }
    pub fn file(&self, name: &str) -> PathBuf {
        self.0.join(name)
    }
}
impl Drop for Folder {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// The shop the tests read: the same data as the other engines' fixtures, a view, an index, a
/// trigger, a virtual table and 100 000 numbers.
pub const SHOP: &str = "
    CREATE TABLE customers (id INTEGER PRIMARY KEY, email TEXT NOT NULL UNIQUE,
        created DATETIME DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE orders (id INTEGER PRIMARY KEY,
        customer INTEGER NOT NULL REFERENCES customers (id) ON DELETE CASCADE,
        total DECIMAL(10, 2), status TEXT CHECK (status IN ('paid', 'sent')), note TEXT);
    CREATE INDEX orders_status ON orders (status);
    CREATE VIEW open_orders AS SELECT id, customer, total FROM orders WHERE status = 'paid';
    CREATE TRIGGER orders_touch AFTER UPDATE OF status ON orders BEGIN
        UPDATE orders SET note = 'touched' WHERE id = NEW.id;
    END;
    CREATE VIRTUAL TABLE docs USING fts5 (title, body);
    CREATE TABLE numbers (n INTEGER PRIMARY KEY, label TEXT);
    INSERT INTO customers (id, email) VALUES (1, 'ana@example.com'), (2, 'luis@example.com');
    INSERT INTO orders (customer, total, status) VALUES (1, 120.5, 'paid'), (1, 9.99, 'sent'),
        (2, 42, 'paid');
    INSERT INTO docs VALUES ('SQLite', 'A database in a file');
    WITH RECURSIVE c(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM c WHERE n < 100000)
        INSERT INTO numbers SELECT n, 'n' || n FROM c;
";

/// A database file made with `sql`.
pub fn database(folder: &Folder, name: &str, sql: &str) -> PathBuf {
    let path = folder.file(name);
    let conn = rusqlite::Connection::open(&path).unwrap();
    conn.execute_batch(sql).unwrap();
    path
}

pub fn params(connection: &str, path: &Path) -> ConnectParams {
    ConnectParams {
        connection: connection.into(),
        database: Some(path.display().to_string()),
        ..ConnectParams::default()
    }
}

pub fn statement(connection: &str, sql: &str, params: Vec<Value>) -> ExecuteParams {
    ExecuteParams {
        connection: connection.into(),
        statement: format!("s-{sql}"),
        sql: sql.into(),
        params,
        page_rows: None,
        max_rows: None,
    }
}

pub async fn run(client: &Client, connection: &str, sql: &str) -> Result<ExecuteResult> {
    client
        .execute(&statement(connection, sql, Vec::new()))
        .await
}

/// The only value of a statement that returns one row with one column.
pub async fn single(client: &Client, connection: &str, sql: &str) -> Value {
    let result = run(client, connection, sql).await.unwrap();
    result.rows[0][0].clone()
}
