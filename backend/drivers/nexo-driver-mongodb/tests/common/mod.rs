//! The driver served over the real protocol, as Nexo's host serves it. The tests that need a
//! server run against the MongoDB of `tools/mongo-fixture.sh` (`NEXO_MONGO_PLAIN`) and are
//! skipped without it.
#![allow(dead_code)]
use async_trait::async_trait;
use nexo_driver_mongodb::MongoDriver;
use nexo_driver_sdk::{
    Client, DriverError, Handler, Peer, Result, methods,
    protocol::{ConnectParams, NetResolveParams},
};
use serde::{Serialize, de::DeserializeOwned};
use serde_json::{Value as Json, json};
use std::sync::{Arc, Mutex};

/// A host that answers `net.check` as an egress policy would: `private…` is refused, and so
/// is `hidden…`, as the far side of a proxy would; a secret limited to `*.example.com` may
/// go nowhere else. It remembers what the driver asked.
#[derive(Clone, Default)]
pub struct Host {
    pub secret: bool,
    pub asked: Arc<Mutex<Vec<String>>>,
}
#[async_trait]
impl Handler for Host {
    async fn request(&self, method: &str, params: Json) -> Result<Json> {
        assert_eq!(method, methods::NET_CHECK, "MongoDB only asks net.check");
        let params: NetResolveParams = serde_json::from_value(params).unwrap();
        let host = params.host;
        self.asked
            .lock()
            .unwrap()
            .push(format!("{host}:{}", params.port));
        if self.secret && !host.ends_with(".example.com") {
            return Err(DriverError::network(format!(
                "secret mongo-pass cannot be sent to {host}"
            )));
        }
        if host.starts_with("private") {
            return Err(DriverError::network(format!(
                "Destination {host} is blocked by the egress policy"
            )));
        }
        if host.starts_with("hidden") {
            return Err(DriverError::network(format!(
                "{host} is refused behind the proxy"
            )));
        }
        Ok(json!({}))
    }
}

/// The driver behind the protocol, in memory, with the host it asks.
pub fn driver_with(host: Host) -> Client {
    let (to_driver, from_host) = tokio::io::duplex(1 << 22);
    let (to_host, from_driver) = tokio::io::duplex(1 << 22);
    tokio::spawn(nexo_driver_sdk::serve(
        MongoDriver::default(),
        from_host,
        to_host,
    ));
    let (peer, _) = Peer::start(from_driver, to_driver, move |_| host.clone());
    Client::new(peer)
}
pub fn driver() -> Client {
    driver_with(Host::default())
}

/// A connection to `uri`, named `name`.
pub fn params(name: &str, uri: &str) -> ConnectParams {
    let mut params = ConnectParams {
        connection: name.into(),
        ..ConnectParams::default()
    };
    params.options.insert("uri".into(), uri.into());
    params
}

/// A method of the `document` extension on a connection.
pub async fn call<P: Serialize, R: DeserializeOwned>(
    client: &Client,
    method: &str,
    connection: &str,
    request: P,
) -> Result<R> {
    client
        .call(
            method,
            &json!({"connection": connection, "request": request}),
        )
        .await
}

pub fn variable(name: &str) -> Option<String> {
    std::env::var(name).ok().filter(|value| !value.is_empty())
}

/// The fixture's standalone server, or the test is skipped.
#[macro_export]
macro_rules! fixture {
    () => {
        match common::variable("NEXO_MONGO_PLAIN") {
            Some(uri) => uri,
            None => {
                eprintln!("skipped: start tools/mongo-fixture.sh");
                return;
            }
        }
    };
}
