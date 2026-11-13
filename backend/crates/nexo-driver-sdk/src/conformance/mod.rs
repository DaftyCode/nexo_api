//! The checks every driver passes, whatever its engine: a driver's tests call [`check`]
//! with a connection to a real server and the statements of its dialect.
//!
//! The driver is served over the real protocol (in memory), so its messages are checked
//! too, not only its methods.
use crate::{
    Client, Driver, ErrorCode, Handler, PROTOCOL_VERSION, Peer, Result, Value, methods,
    protocol::{ConnectParams, NetResolveParams, NetResolved, ObjectParams},
    statements::{ExecuteParams, ExecuteResult},
};
use async_trait::async_trait;
use serde_json::{Value as Json, json};
use std::time::Duration;
use steps::{cancel, pages, rollback};

mod steps;

/// What a driver gives to be checked.
pub struct Suite {
    /// A connection that works.
    pub connect: ConnectParams,
    /// The same with a password the server refuses, when the engine has passwords.
    pub wrong_password: Option<ConnectParams>,
    /// A statement that returns exactly `paged_rows` rows, more than two pages of
    /// [`Suite::PAGE`].
    pub paged_sql: String,
    pub paged_rows: usize,
    /// A statement that runs for a minute unless it is cancelled.
    pub slow_sql: Option<String>,
    /// A statement the server refuses to parse.
    pub invalid_sql: String,
    /// Statements that return one row with one column, and the value it must hold.
    pub values: Vec<(String, Value)>,
    /// A write and a count of what it writes, to check that a rollback undoes it.
    pub rollback: Option<(String, String)>,
}
impl Suite {
    pub const PAGE: u32 = 50;
}

/// Answers the driver as a host without an egress policy would.
struct OpenHost;
#[async_trait]
impl Handler for OpenHost {
    async fn request(&self, method: &str, params: Json) -> Result<Json> {
        if method != methods::NET_RESOLVE {
            return Err(crate::DriverError::unsupported(method));
        }
        let params: NetResolveParams = serde_json::from_value(params)
            .map_err(|error| crate::DriverError::invalid(error.to_string()))?;
        let addresses = tokio::net::lookup_host((params.host.as_str(), params.port))
            .await
            .map_err(|error| crate::DriverError::network(error.to_string()))?
            .map(|address| address.to_string())
            .collect();
        Ok(json!(NetResolved { addresses }))
    }
}

struct Checks {
    client: Client,
    connection: String,
    failures: Vec<String>,
    statements: u32,
}
impl Checks {
    fn expect(&mut self, what: &str, passed: bool, found: impl std::fmt::Debug) {
        if !passed {
            self.failures.push(format!("{what}: found {found:?}"));
        }
    }
    fn code(&mut self, what: &str, outcome: Result<impl std::fmt::Debug>, code: ErrorCode) {
        let passed = matches!(&outcome, Err(error) if error.code == code);
        self.expect(what, passed, outcome);
    }
    fn statement(&mut self, sql: &str) -> ExecuteParams {
        self.statements += 1;
        ExecuteParams {
            connection: self.connection.clone(),
            statement: format!("conformance-{}", self.statements),
            sql: sql.to_owned(),
            params: Vec::new(),
            page_rows: Some(Suite::PAGE),
            max_rows: None,
        }
    }
    async fn execute(&mut self, sql: &str) -> Result<ExecuteResult> {
        let params = self.statement(sql);
        self.client.execute(&params).await
    }
    /// The only value of a statement that returns one row with one column.
    async fn single(&mut self, sql: &str) -> Option<Value> {
        let rows = self.execute(sql).await.ok()?.rows;
        rows.into_iter().next()?.into_iter().next()
    }
}

/// Runs every check and returns what failed; an empty list is a conforming driver.
pub async fn check<D: Driver>(driver: D, suite: Suite) -> Vec<String> {
    let (to_driver, from_host) = tokio::io::duplex(1 << 20);
    let (to_host, from_driver) = tokio::io::duplex(1 << 20);
    let serving = tokio::spawn(crate::serve(driver, from_host, to_host));
    let (peer, _) = Peer::start(from_driver, to_driver, |_| OpenHost);
    let mut checks = Checks {
        client: Client::new(peer.clone()),
        connection: suite.connect.connection.clone(),
        failures: Vec::new(),
        statements: 0,
    };
    run(&mut checks, &suite).await;
    peer.close();
    let stopped = tokio::time::timeout(Duration::from_secs(5), serving).await;
    checks.expect("the driver stops when its input ends", stopped.is_ok(), ());
    checks.failures
}

async fn run(checks: &mut Checks, suite: &Suite) {
    let client = checks.client.clone();
    let hello = match client.hello().await {
        Ok(hello) => hello,
        Err(error) => return checks.expect("hello", false, error),
    };
    checks.expect(
        "the protocol version",
        hello.protocol == PROTOCOL_VERSION,
        hello.protocol,
    );
    checks.expect("a driver id", !hello.driver.id.is_empty(), &hello.driver);
    checks.expect(
        "a dialect name",
        !hello.dialect.name.is_empty(),
        &hello.dialect.name,
    );

    if let Some(wrong) = &suite.wrong_password {
        let outcome = client.connect(wrong).await;
        checks.code(
            "a wrong password is an auth error",
            outcome,
            ErrorCode::Auth,
        );
    }
    match client.connect(&suite.connect).await {
        Ok(server) => checks.expect(
            "a server version",
            !server.server_version.is_empty(),
            server,
        ),
        Err(error) => return checks.expect("connect", false, error),
    }
    let top = ObjectParams {
        connection: checks.connection.clone(),
        path: Vec::new(),
    };
    let nodes = client.tree(&top).await;
    let listed = matches!(&nodes, Ok(nodes) if !nodes.is_empty());
    checks.expect("the top of the tree has nodes", listed, nodes);

    pages(checks, suite).await;
    let outcome = checks.execute(&suite.invalid_sql).await;
    checks.code(
        "an invalid statement is a syntax error",
        outcome,
        ErrorCode::Syntax,
    );
    for (sql, expected) in &suite.values {
        let found = checks.single(sql).await;
        checks.expect(
            &format!("the value of `{sql}`"),
            found.as_ref() == Some(expected),
            &found,
        );
    }
    if let Some(sql) = &suite.slow_sql {
        cancel(checks, sql, hello.capabilities.cancel).await;
    }
    if let Some((write, count)) = &suite.rollback
        && hello.capabilities.transactions
    {
        rollback(checks, write, count).await;
    }

    let mut unknown = checks.statement(&suite.paged_sql);
    unknown.connection = "no-such-connection".into();
    let outcome = client.execute(&unknown).await;
    checks.code(
        "an unknown connection is refused",
        outcome,
        ErrorCode::Invalid,
    );
    let outcome = client.disconnect(&checks.connection).await;
    checks.expect("disconnect", outcome.is_ok(), outcome);
    let outcome = checks.execute(&suite.paged_sql).await;
    checks.expect(
        "a closed connection runs nothing",
        outcome.is_err(),
        outcome,
    );
}
