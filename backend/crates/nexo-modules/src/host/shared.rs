//! What the host keeps: its drivers and their connections, and how a driver is started and
//! asked.
use super::HostConfig;
use crate::{connections::Connections, process::DriverProcess, redact::Secrets, resolve::Answers};
use nexo_application::ports::NetworkPolicy;
use nexo_driver_sdk::{DriverError, Result};
use serde::{Serialize, de::DeserializeOwned};
use std::{
    collections::HashMap,
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
    time::Duration,
};
use tokio::sync::Mutex;

pub(crate) struct Shared {
    pub config: HostConfig,
    pub network: Arc<dyn NetworkPolicy>,
    pub processes: Mutex<HashMap<String, Arc<DriverProcess>>>,
    pub connections: Arc<Connections>,
    pub generations: AtomicU64,
}

fn module_name(module: &str) -> Result<&str> {
    let valid = (1..=32).contains(&module.len())
        && module
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-');
    if valid {
        Ok(module)
    } else {
        Err(DriverError::invalid("Invalid module name"))
    }
}

impl Shared {
    /// The running driver of a module, started if it is not.
    pub async fn process(&self, module: &str) -> Result<Arc<DriverProcess>> {
        let module = module_name(module)?;
        let mut processes = self.processes.lock().await;
        if let Some(process) = processes.get(module) {
            if process.alive() {
                process.touch();
                return Ok(process.clone());
            }
            self.connections.forget_process(module, process.generation);
            processes.remove(module);
        }
        if processes.len() >= self.config.max_processes {
            // Makes room with a driver that has no connections; otherwise refuses.
            let unused = processes
                .keys()
                .find(|running| self.connections.count(running) == 0)
                .cloned();
            let unused = unused.and_then(|running| processes.remove(&running));
            match unused {
                Some(process) => process.stop().await,
                None => {
                    return Err(DriverError::invalid(
                        "Too many database drivers are running; close some connections first",
                    ));
                }
            }
        }
        let directory = self.config.modules_dir.as_ref();
        let path = directory
            .map(|directory| {
                directory.join(format!(
                    "nexo-driver-{module}{}",
                    std::env::consts::EXE_SUFFIX
                ))
            })
            .filter(|path| path.is_file())
            .ok_or_else(|| {
                DriverError::unsupported(format!("The {module} module is not installed"))
            })?;
        let answers = Answers {
            module: module.to_owned(),
            network: self.network.clone(),
            connections: self.connections.clone(),
            secrets: Arc::new(Secrets::default()),
            log: self.config.log.clone(),
        };
        let generation = self.generations.fetch_add(1, Ordering::Relaxed);
        let process = DriverProcess::start(&path, generation, answers).await?;
        processes.insert(module.to_owned(), process.clone());
        Ok(process)
    }

    /// Asks a driver and waits for its answer, shown without the secrets it was given.
    pub async fn ask<P, R>(
        &self,
        process: &DriverProcess,
        method: &str,
        params: &P,
        limit: Option<Duration>,
    ) -> Result<R>
    where
        P: Serialize + ?Sized,
        R: DeserializeOwned,
    {
        process.touch();
        let limit = limit.unwrap_or(self.config.request_timeout);
        let answer = tokio::time::timeout(limit, process.client.call(method, params)).await;
        process.touch();
        match answer {
            Ok(Ok(answer)) => Ok(answer),
            Ok(Err(error)) => Err(process.secrets.error(error)),
            Err(_) => Err(DriverError::timeout(format!(
                "The {} driver did not answer in {} s",
                process.module,
                limit.as_secs().max(1)
            ))),
        }
    }
}
