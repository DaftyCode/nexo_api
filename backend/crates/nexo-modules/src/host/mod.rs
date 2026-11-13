//! The host of the driver processes: it starts each one when a connection needs it, sends
//! it what the application asks, and stops it when nobody uses it.
mod idle;
mod shared;

use crate::connections::{Connection, SecretHosts};
use idle::close_idle;
use nexo_application::ports::NetworkPolicy;
use nexo_driver_sdk::{
    DriverError, Result, limits, methods,
    protocol::{ConnectParams, Hello, ServerInfo, TestReport},
};
use serde::{Serialize, de::DeserializeOwned};
use shared::Shared;
use std::{
    path::PathBuf,
    sync::{Arc, atomic::AtomicU64},
    time::{Duration, Instant},
};
use tokio::sync::Mutex;

/// Receives the log lines of the drivers: module, level and text, already without secrets.
pub type LogSink = Arc<dyn Fn(&str, &str, &str) + Send + Sync>;

/// Finds the executable of a module's driver, ready to run.
pub trait Executables: Send + Sync {
    fn executable(&self, module: &str) -> Result<PathBuf>;
}
/// No module can run.
pub struct NoModules;
impl Executables for NoModules {
    fn executable(&self, module: &str) -> Result<PathBuf> {
        Err(DriverError::unsupported(format!(
            "The {module} module is not installed"
        )))
    }
}
/// The drivers of a folder, run as they are: drivers built by Cargo, for development and
/// tests.
pub struct Folder(pub PathBuf);
impl Executables for Folder {
    fn executable(&self, module: &str) -> Result<PathBuf> {
        Some(self.0.join(crate::catalog::executable_name(module)))
            .filter(|path| path.is_file())
            .ok_or_else(|| {
                DriverError::unsupported(format!("The {module} module is not installed"))
            })
    }
}

pub struct HostConfig {
    /// Where the driver of each module is.
    pub executables: Arc<dyn Executables>,
    /// How long a connection, and then its process, stay without being used.
    pub idle: Duration,
    /// How long to wait for a driver's answer when the caller does not say.
    pub request_timeout: Duration,
    pub max_processes: usize,
    pub log: LogSink,
}
impl Default for HostConfig {
    fn default() -> Self {
        Self {
            executables: Arc::new(NoModules),
            idle: limits::IDLE,
            // A statement has its own limit in the driver; the host waits a little longer.
            request_timeout: limits::STATEMENT + Duration::from_secs(5),
            max_processes: 8,
            log: Arc::new(|module, level, line| match level {
                "error" | "warn" => tracing::warn!(target: "nexo::driver", module, "{line}"),
                _ => tracing::info!(target: "nexo::driver", module, "{line}"),
            }),
        }
    }
}
#[derive(Clone)]
pub struct DriverHost {
    shared: Arc<Shared>,
}

fn stopped(module: &str) -> DriverError {
    DriverError::closed(format!(
        "The connection is closed: the {module} driver stopped. Connect again."
    ))
}

impl DriverHost {
    /// Must be called inside a Tokio runtime: it starts the task that closes what is idle.
    pub fn new(config: HostConfig, network: Arc<dyn NetworkPolicy>) -> Self {
        let tick = (config.idle / 4).max(Duration::from_millis(25));
        let shared = Arc::new(Shared {
            config,
            network,
            processes: Mutex::default(),
            connections: Arc::default(),
            generations: AtomicU64::new(1),
        });
        tokio::spawn(close_idle(Arc::downgrade(&shared), tick));
        Self { shared }
    }

    /// What the driver of a module says about itself; starts it if needed.
    pub async fn hello(&self, module: &str) -> Result<Hello> {
        Ok(self.shared.process(module).await?.hello.clone())
    }

    /// Opens a connection in the driver of `module`. `secret_hosts` are the vault secrets
    /// of the connection that may only reach some hosts.
    pub async fn connect(
        &self,
        module: &str,
        params: ConnectParams,
        secret_hosts: SecretHosts,
    ) -> Result<ServerInfo> {
        self.opening(module, &params, secret_hosts, methods::CONNECT, true)
            .await
    }

    /// Opens a connection, measures it and closes it.
    pub async fn test(
        &self,
        module: &str,
        params: ConnectParams,
        secret_hosts: SecretHosts,
    ) -> Result<TestReport> {
        self.opening(module, &params, secret_hosts, methods::TEST, false)
            .await
    }

    async fn opening<R: DeserializeOwned>(
        &self,
        module: &str,
        params: &ConnectParams,
        secret_hosts: SecretHosts,
        method: &str,
        keep: bool,
    ) -> Result<R> {
        let shared = &self.shared;
        let process = shared.process(module).await?;
        process.secrets.add(params.password.as_deref());
        process.secrets.add(params.tls.key_pem.as_deref());
        // Registered first: the driver asks about this connection while it opens it.
        let connection = Connection {
            module: module.to_owned(),
            generation: process.generation,
            secret_hosts,
            last_used: Instant::now(),
        };
        shared.connections.open(&params.connection, connection)?;
        let outcome = shared.ask(&process, method, params, None).await;
        if outcome.is_err() || !keep {
            shared.connections.close(&params.connection);
        }
        outcome
    }

    /// Asks the driver of an open connection, within the default time.
    pub async fn call<P, R>(&self, connection: &str, method: &str, params: &P) -> Result<R>
    where
        P: Serialize + ?Sized,
        R: DeserializeOwned,
    {
        self.call_within(connection, method, params, None).await
    }

    /// Asks the driver of an open connection, waiting at most `limit`.
    pub async fn call_within<P, R>(
        &self,
        connection: &str,
        method: &str,
        params: &P,
        limit: Option<Duration>,
    ) -> Result<R>
    where
        P: Serialize + ?Sized,
        R: DeserializeOwned,
    {
        let shared = &self.shared;
        let (module, generation) = shared
            .connections
            .touch(connection)
            .ok_or_else(|| DriverError::invalid("The connection is not open"))?;
        // Never starts a process here: a new one would not have this connection.
        let process = shared.processes.lock().await.get(&module).cloned();
        let process = process.filter(|process| process.alive() && process.generation == generation);
        let Some(process) = process else {
            shared.connections.forget_process(&module, generation);
            return Err(stopped(&module));
        };
        shared.ask(&process, method, params, limit).await
    }

    pub async fn disconnect(&self, connection: &str) -> Result<()> {
        let outcome = self
            .call(
                connection,
                methods::DISCONNECT,
                &serde_json::json!({"connection": connection}),
            )
            .await;
        self.shared.connections.close(connection);
        outcome
    }

    /// The modules whose driver is running.
    pub async fn running(&self) -> Vec<String> {
        let processes = self.shared.processes.lock().await;
        let mut modules: Vec<String> = processes
            .values()
            .filter(|process| process.alive())
            .map(|process| process.module.clone())
            .collect();
        modules.sort();
        modules
    }

    /// Stops the driver of a module, if it runs; its connections are closed. Its executable
    /// can then be replaced or deleted.
    pub async fn stop(&self, module: &str) {
        let process = self.shared.processes.lock().await.remove(module);
        if let Some(process) = process {
            self.shared
                .connections
                .forget_process(module, process.generation);
            process.stop().await;
        }
    }

    /// Stops every driver; their connections are closed.
    pub async fn shutdown(&self) {
        let processes: Vec<_> = self.shared.processes.lock().await.drain().collect();
        for (module, process) in processes {
            self.shared
                .connections
                .forget_process(&module, process.generation);
            process.stop().await;
        }
    }
}
