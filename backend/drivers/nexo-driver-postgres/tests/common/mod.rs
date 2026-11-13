//! The driver served over the real protocol, as Nexo's host serves it, against the servers
//! of `tools/sql-fixture.sh`. Without them (no `NEXO_SQL_PG_HOST`), the tests are skipped.
#![allow(dead_code)]
use async_trait::async_trait;
use nexo_driver_postgres::PostgresDriver;
use nexo_driver_sdk::{
    Client, DriverError, Handler, Peer, Result, Value, methods,
    protocol::{ConnectParams, NetResolveParams, NetResolved, TlsMode, TlsSettings},
    statements::{ExecuteParams, ExecuteResult},
};
use serde_json::{Value as Json, json};

/// A host that resolves names as the system does and refuses `blocked.test`, as an egress
/// policy would.
struct Host;
#[async_trait]
impl Handler for Host {
    async fn request(&self, method: &str, params: Json) -> Result<Json> {
        assert_eq!(method, methods::NET_RESOLVE);
        let params: NetResolveParams = serde_json::from_value(params).unwrap();
        if params.host == "blocked.test" {
            return Err(DriverError::network(
                "Destination blocked.test is blocked by the egress policy",
            ));
        }
        let addresses = tokio::net::lookup_host((params.host.as_str(), params.port))
            .await
            .map_err(|error| DriverError::network(error.to_string()))?
            .map(|address| address.to_string())
            .collect();
        Ok(json!(NetResolved { addresses }))
    }
}

/// The driver behind the protocol, in memory.
pub fn driver() -> Client {
    let (to_driver, from_host) = tokio::io::duplex(1 << 20);
    let (to_host, from_driver) = tokio::io::duplex(1 << 20);
    tokio::spawn(nexo_driver_sdk::serve(
        PostgresDriver::default(),
        from_host,
        to_host,
    ));
    let (peer, _) = Peer::start(from_driver, to_driver, |_| Host);
    Client::new(peer)
}

pub fn variable(name: &str) -> Option<String> {
    std::env::var(name).ok().filter(|value| !value.is_empty())
}

/// The fixture's connection on `port` (the plain server when `None`).
pub fn params(name: &str, port: Option<&str>) -> Option<ConnectParams> {
    let host = variable("NEXO_SQL_PG_HOST")?;
    let port = match port {
        Some(variable_name) => variable(variable_name)?,
        None => variable("NEXO_SQL_PG_PORT")?,
    };
    Some(ConnectParams {
        connection: name.into(),
        host: Some(host),
        port: port.parse().ok(),
        database: variable("NEXO_SQL_PG_DATABASE"),
        user: variable("NEXO_SQL_PG_USER"),
        password: variable("NEXO_SQL_PG_PASSWORD"),
        ..ConnectParams::default()
    })
}

/// The TLS server's connection, with the CA and the client certificate.
pub fn tls_params(name: &str) -> Option<ConnectParams> {
    let read = |name| std::fs::read_to_string(variable(name)?).ok();
    let mut params = params(name, Some("NEXO_SQL_PG_TLS_PORT"))?;
    params.host = Some("localhost".into());
    params.tls = TlsSettings {
        mode: TlsMode::Verify,
        ca_pem: read("NEXO_SQL_PG_CA"),
        cert_pem: read("NEXO_SQL_PG_CLIENT_CERT"),
        key_pem: read("NEXO_SQL_PG_CLIENT_KEY"),
    };
    Some(params)
}

pub async fn run(client: &Client, connection: &str, sql: &str) -> Result<ExecuteResult> {
    client
        .execute(&ExecuteParams {
            connection: connection.into(),
            statement: format!("s-{}", sql.len()),
            sql: sql.into(),
            params: Vec::new(),
            page_rows: Some(1000),
            max_rows: None,
        })
        .await
}

/// The only value of a statement that returns one row with one column.
pub async fn single(client: &Client, connection: &str, sql: &str) -> Value {
    let result = run(client, connection, sql).await.unwrap();
    result.rows[0][0].clone()
}

/// Skips a test without the servers, saying so.
#[macro_export]
macro_rules! fixture {
    ($expression:expr) => {
        match $expression {
            Some(value) => value,
            None => {
                eprintln!("skipped: start tools/sql-fixture.sh and export its variables");
                return;
            }
        }
    };
}
