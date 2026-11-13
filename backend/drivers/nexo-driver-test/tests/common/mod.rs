//! A host over the test driver's real executable, with a network policy and a log the
//! tests can look at.
#![allow(dead_code)]
use async_trait::async_trait;
use nexo_application::ports::NetworkPolicy;
use nexo_domain::{Error, Result};
use nexo_driver_sdk::{protocol::ConnectParams, statements::ExecuteParams};
use nexo_modules::{DriverHost, Folder, HostConfig};
use std::{
    net::SocketAddr,
    path::PathBuf,
    sync::{Arc, Mutex},
    time::Duration,
};

/// Refuses the hosts named `private…` and answers a fixed address for the others.
#[derive(Default)]
pub struct Policy {
    pub asked: Mutex<Vec<(String, u16)>>,
}
#[async_trait]
impl NetworkPolicy for Policy {
    async fn check_destination(&self, host: &str, port: u16) -> Result<()> {
        self.resolve_destination(host, port).await.map(|_| ())
    }
    async fn resolve_destination(&self, host: &str, port: u16) -> Result<Vec<SocketAddr>> {
        self.asked.lock().unwrap().push((host.to_owned(), port));
        if host.starts_with("private") {
            return Err(Error::Validation(format!(
                "Destination {host} is blocked by the egress policy"
            )));
        }
        Ok(vec![SocketAddr::from(([203, 0, 113, 7], port))])
    }
}

pub type Log = Arc<Mutex<Vec<String>>>;

pub struct Fixture {
    pub host: DriverHost,
    pub policy: Arc<Policy>,
    pub log: Log,
}

/// The directory where Cargo left the test driver's executable.
pub fn modules_dir() -> PathBuf {
    let executable = PathBuf::from(env!("CARGO_BIN_EXE_nexo-driver-test"));
    executable.parent().unwrap().to_owned()
}

pub fn fixture_with(change: impl FnOnce(&mut HostConfig)) -> Fixture {
    let log = Log::default();
    let lines = log.clone();
    let mut config = HostConfig {
        executables: Arc::new(Folder(modules_dir())),
        log: Arc::new(move |module, level, line| {
            lines
                .lock()
                .unwrap()
                .push(format!("{module} {level} {line}"));
        }),
        ..HostConfig::default()
    };
    change(&mut config);
    let policy = Arc::new(Policy::default());
    Fixture {
        host: DriverHost::new(config, policy.clone()),
        policy,
        log,
    }
}
pub fn fixture() -> Fixture {
    fixture_with(|_| {})
}

pub fn connection(name: &str) -> ConnectParams {
    ConnectParams {
        connection: name.into(),
        user: Some("ana".into()),
        password: Some("secret".into()),
        ..ConnectParams::default()
    }
}
pub fn statement(connection: &str, name: &str, sql: &str) -> ExecuteParams {
    ExecuteParams {
        connection: connection.into(),
        statement: name.into(),
        sql: sql.into(),
        params: Vec::new(),
        page_rows: Some(50),
        max_rows: None,
    }
}

/// Waits until `done` says so, for what happens in another process.
pub async fn eventually(what: &str, mut done: impl AsyncFnMut() -> bool) {
    for _ in 0..200 {
        if done().await {
            return;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    panic!("never happened: {what}");
}
