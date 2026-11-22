//! The Redis module (DB-35): Redis, Valkey and the servers that speak RESP, through the
//! `redis` library with rustls on aws-lc-rs. One server, a master named by Sentinels, or a
//! cluster; every address is resolved by the host. Redis is not SQL: besides the protocol
//! every driver speaks (its tree lists the databases), it answers the `keyvalue` extension
//! of the SDK: keys by pages of `SCAN`, a key's value by its type, changes, commands and
//! subscriptions.
//!
//! The design of the drivers is in `docs/ARCHITECTURE.md`, section "Database modules".
mod connection;
mod keys;
mod pubsub;
mod reply;
mod server;
mod write;

pub use connection::SETTINGS;

use async_trait::async_trait;
use connection::{Conn, Target, failure};
use nexo_driver_sdk::{
    Driver, DriverError, HostLink, PROTOCOL_VERSION, Result,
    keyvalue::{
        self, CommandParams, EventsParams, Reply, SubscribeParams, Subscribed, UnsubscribeParams,
    },
    limits,
    protocol::{
        Capabilities, ConnectParams, Dialect, DriverInfo, Hello, ObjectParams, ServerInfo,
        TestReport, TreeNode,
    },
    statements::{CursorParams, ExecuteParams, ExecuteResult, FetchParams, Page},
};
use pubsub::Subscription;
use serde::{Serialize, de::DeserializeOwned};
use serde_json::Value as Json;
use std::{
    collections::HashMap,
    sync::{
        Arc, Mutex,
        atomic::{AtomicU64, Ordering},
    },
    time::Instant,
};

struct RedisConnection {
    conn: Conn,
    target: Target,
    db: i64,
    subscriptions: Mutex<HashMap<String, Arc<Subscription>>>,
}

#[derive(Default)]
pub struct RedisDriver {
    connections: Mutex<HashMap<String, Arc<RedisConnection>>>,
    subscriptions: AtomicU64,
}

fn not_open() -> DriverError {
    DriverError::invalid("The connection is not open")
}

fn read<T: DeserializeOwned>(params: Json) -> Result<T> {
    serde_json::from_value(params)
        .map_err(|error| DriverError::invalid(format!("Invalid request: {error}")))
}
fn answer<T: Serialize>(value: T) -> Result<Json> {
    serde_json::to_value(value).map_err(|error| DriverError::internal(error.to_string()))
}

/// Commands that would take the shared connection for themselves.
const REFUSED: [&str; 6] = [
    "SUBSCRIBE",
    "PSUBSCRIBE",
    "SSUBSCRIBE",
    "MONITOR",
    "SYNC",
    "PSYNC",
];

impl RedisDriver {
    fn connection(&self, name: &str) -> Result<Arc<RedisConnection>> {
        self.connections
            .lock()
            .unwrap()
            .get(name)
            .cloned()
            .ok_or_else(not_open)
    }

    async fn command(&self, params: CommandParams) -> Result<Reply> {
        let connection = self.connection(&params.connection)?;
        let args = params
            .args
            .iter()
            .map(reply::bytes)
            .collect::<Result<Vec<_>>>()?;
        let name = args
            .first()
            .map(|name| String::from_utf8_lossy(name).to_ascii_uppercase())
            .ok_or_else(|| DriverError::invalid("Write a command"))?;
        if REFUSED.contains(&name.as_str()) {
            return Err(DriverError::invalid(format!(
                "{name} is not run in the console: follow channels in the realtime panel"
            )));
        }
        let mut command = redis::cmd(&name);
        for arg in &args[1..] {
            command.arg(arg.as_slice());
        }
        let started = Instant::now();
        let reply = match connection.conn.run(&command).await {
            Ok(value) => reply::json(&value),
            // An error of the server is its answer, as redis-cli shows it.
            Err(error) if error.kind() != redis::ErrorKind::Io && !error.is_timeout() => {
                serde_json::json!({"error": error.to_string()})
            }
            Err(error) => return Err(failure(error)),
        };
        Ok(Reply {
            reply,
            elapsed_ms: started.elapsed().as_millis() as u64,
        })
    }

    async fn subscribe(&self, params: SubscribeParams) -> Result<Subscribed> {
        let connection = self.connection(&params.connection)?;
        if connection.subscriptions.lock().unwrap().len() >= pubsub::MAX {
            return Err(DriverError::invalid(
                "Too many subscriptions are open: close one",
            ));
        }
        let subscription =
            pubsub::subscribe(&connection.target, params.channels, params.patterns).await?;
        let id = format!(
            "s{}",
            self.subscriptions.fetch_add(1, Ordering::Relaxed) + 1
        );
        connection
            .subscriptions
            .lock()
            .unwrap()
            .insert(id.clone(), Arc::new(subscription));
        Ok(Subscribed { subscription: id })
    }

    fn subscription(&self, connection: &str, id: &str) -> Result<Arc<Subscription>> {
        self.connection(connection)?
            .subscriptions
            .lock()
            .unwrap()
            .get(id)
            .cloned()
            .ok_or_else(|| DriverError::invalid("The subscription was closed"))
    }
}

#[async_trait]
impl Driver for RedisDriver {
    fn hello(&self) -> Hello {
        Hello {
            protocol: PROTOCOL_VERSION,
            driver: DriverInfo {
                id: "redis".into(),
                name: "Redis and Valkey".into(),
                version: env!("CARGO_PKG_VERSION").into(),
            },
            capabilities: Capabilities {
                extensions: vec![keyvalue::EXTENSION.into()],
                ..Capabilities::default()
            },
            dialect: Dialect {
                name: "redis".into(),
                ..Dialect::default()
            },
        }
    }

    async fn connect(&self, host: &HostLink, params: ConnectParams) -> Result<ServerInfo> {
        if self.connections.lock().unwrap().len() >= limits::CONNECTIONS {
            return Err(DriverError::invalid("Too many Redis connections are open"));
        }
        let (conn, target, db) = connection::open(host, &params).await?;
        let info = server::info(&conn, &params, db).await?;
        let opened = RedisConnection {
            conn,
            target,
            db,
            subscriptions: Mutex::new(HashMap::new()),
        };
        self.connections
            .lock()
            .unwrap()
            .insert(params.connection.clone(), Arc::new(opened));
        Ok(info)
    }

    async fn disconnect(&self, connection: &str) -> Result<()> {
        let removed = self.connections.lock().unwrap().remove(connection);
        removed.map(|_| ()).ok_or_else(not_open)
    }

    async fn test(&self, host: &HostLink, params: ConnectParams) -> Result<TestReport> {
        let (conn, _, db) = connection::open(host, &params).await?;
        let started = Instant::now();
        let info = server::info(&conn, &params, db).await?;
        let ping_ms = started.elapsed().as_millis() as u64;
        if let Conn::Cluster(_) = conn {
            for (address, port) in keys::primaries(&conn).await.unwrap_or_default() {
                host.log("info", format!("Primary {address}:{port}")).await;
            }
        }
        Ok(TestReport {
            server: info,
            ping_ms,
        })
    }

    async fn tree(&self, params: ObjectParams) -> Result<Vec<TreeNode>> {
        let connection = self.connection(&params.connection)?;
        if !params.path.is_empty() {
            return Ok(Vec::new());
        }
        server::databases(&connection.conn, connection.db).await
    }

    /// Redis has no SQL: a line written in the editor runs as a command of the console.
    async fn execute(&self, params: ExecuteParams) -> Result<ExecuteResult> {
        Err(DriverError::invalid(format!(
            "Redis runs commands in its console, not SQL ({})",
            params.sql.split_whitespace().next().unwrap_or_default()
        )))
    }
    async fn fetch(&self, _params: FetchParams) -> Result<Page> {
        Err(DriverError::invalid("Redis has no results to read on"))
    }
    async fn close(&self, _params: CursorParams) -> Result<()> {
        Ok(())
    }

    async fn extension(&self, _host: &HostLink, method: &str, params: Json) -> Result<Json> {
        use keyvalue::methods;
        match method {
            methods::SCAN => {
                let params: keyvalue::ScanParams = read(params)?;
                let connection = self.connection(&params.connection)?;
                answer(keys::scan(&connection.conn, params).await?)
            }
            methods::GET => {
                let params: keyvalue::GetParams = read(params)?;
                let connection = self.connection(&params.connection)?;
                answer(keys::get(&connection.conn, params).await?)
            }
            methods::WRITE => {
                let params: keyvalue::WriteParams = read(params)?;
                let connection = self.connection(&params.connection)?;
                answer(write::write(&connection.conn, params).await?)
            }
            methods::COMMAND => answer(self.command(read(params)?).await?),
            methods::SUBSCRIBE => answer(self.subscribe(read(params)?).await?),
            methods::EVENTS => {
                let params: EventsParams = read(params)?;
                let subscription = self.subscription(&params.connection, &params.subscription)?;
                answer(subscription.events(params.after))
            }
            methods::UNSUBSCRIBE => {
                let params: UnsubscribeParams = read(params)?;
                let connection = self.connection(&params.connection)?;
                connection
                    .subscriptions
                    .lock()
                    .unwrap()
                    .remove(&params.subscription);
                answer(serde_json::json!({}))
            }
            other => Err(DriverError::invalid(format!("Unknown method {other}"))),
        }
    }
}
