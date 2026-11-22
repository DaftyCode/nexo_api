//! The driver served over the real protocol, as Nexo's host serves it, against the Cassandra
//! of `tools/nosql-fixture.sh`. Without it (no `NEXO_CASSANDRA_HOST`), the tests are skipped.
#![allow(dead_code)]
use async_trait::async_trait;
use nexo_driver_cassandra::CassandraDriver;
use nexo_driver_sdk::{
    Client, DriverError, Handler, Peer, Result, Value, methods,
    protocol::{ConnectParams, NetResolveParams, NetResolved},
    statements::{ExecuteParams, ExecuteResult},
};
use serde_json::{Value as Json, json};
use std::{
    collections::BTreeMap,
    sync::{Arc, Mutex},
};

/// A host that resolves names as the system does, refuses the addresses it is told to (as an
/// egress policy would), and remembers what the driver asked.
#[derive(Clone, Default)]
pub struct Host {
    pub refused: Arc<Mutex<Vec<String>>>,
    pub asked: Arc<Mutex<Vec<String>>>,
}
#[async_trait]
impl Handler for Host {
    async fn request(&self, method: &str, params: Json) -> Result<Json> {
        if method != methods::NET_RESOLVE {
            return Ok(json!({}));
        }
        let params: NetResolveParams = serde_json::from_value(params).unwrap();
        self.asked.lock().unwrap().push(params.host.clone());
        if self.refused.lock().unwrap().contains(&params.host) {
            return Err(DriverError::network(format!(
                "Destination {} is blocked by the egress policy",
                params.host
            )));
        }
        let addresses = tokio::net::lookup_host((params.host.as_str(), params.port))
            .await
            .map_err(|error| DriverError::network(error.to_string()))?
            .map(|address| address.to_string())
            .collect();
        Ok(json!(NetResolved { addresses }))
    }
}

/// The driver behind the protocol, in memory, with the host it asks.
pub fn driver_with(host: Host) -> Client {
    let (to_driver, from_host) = tokio::io::duplex(1 << 20);
    let (to_host, from_driver) = tokio::io::duplex(1 << 20);
    tokio::spawn(nexo_driver_sdk::serve(
        CassandraDriver::default(),
        from_host,
        to_host,
    ));
    let (peer, _) = Peer::start(from_driver, to_driver, move |_| host.clone());
    Client::new(peer)
}
pub fn driver() -> Client {
    driver_with(Host::default())
}

pub fn variable(name: &str) -> Option<String> {
    std::env::var(name).ok().filter(|value| !value.is_empty())
}

/// The fixture's Cassandra, on the keyspace `shop`.
pub fn params(name: &str) -> Option<ConnectParams> {
    Some(ConnectParams {
        connection: name.into(),
        host: Some(variable("NEXO_CASSANDRA_HOST")?),
        port: variable("NEXO_CASSANDRA_PORT")?.parse().ok(),
        database: Some("shop".into()),
        options: BTreeMap::from([(
            "localDc".to_owned(),
            variable("NEXO_CASSANDRA_DC").unwrap_or_default(),
        )]),
        ..ConnectParams::default()
    })
}

pub async fn run(client: &Client, connection: &str, sql: &str) -> Result<ExecuteResult> {
    run_with(client, connection, sql, Vec::new()).await
}
pub async fn run_with(
    client: &Client,
    connection: &str,
    sql: &str,
    params: Vec<Value>,
) -> Result<ExecuteResult> {
    client
        .execute(&ExecuteParams {
            connection: connection.into(),
            statement: format!("s-{}", sql.len()),
            sql: sql.into(),
            params,
            page_rows: Some(1000),
            max_rows: None,
        })
        .await
}

/// Skips a test without the server, saying so.
#[macro_export]
macro_rules! fixture {
    ($expression:expr) => {
        match $expression {
            Some(value) => value,
            None => {
                eprintln!("skipped: start tools/nosql-fixture.sh and export its variables");
                return;
            }
        }
    };
}
