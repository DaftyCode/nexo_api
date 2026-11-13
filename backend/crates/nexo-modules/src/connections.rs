//! The connections open in the drivers: which process each one lives in, the secrets that
//! may only reach some hosts, and when it was last used.
use nexo_domain::hosts::AllowedHosts;
use nexo_driver_sdk::{DriverError, Result, limits};
use std::{
    collections::HashMap,
    sync::Mutex,
    time::{Duration, Instant},
};

/// Vault secrets of a connection that may only reach some hosts, by name.
pub(crate) type SecretHosts = Vec<(String, AllowedHosts)>;

pub(crate) struct Connection {
    pub module: String,
    /// The start of the driver process it lives in: a later process does not have it.
    pub generation: u64,
    pub secret_hosts: SecretHosts,
    pub last_used: Instant,
}

#[derive(Default)]
pub(crate) struct Connections(Mutex<HashMap<String, Connection>>);
impl Connections {
    /// Registers a connection before its driver is asked to open it, so the driver's
    /// questions about it can be answered.
    pub fn open(&self, name: &str, connection: Connection) -> Result<()> {
        let mut connections = self.0.lock().unwrap();
        if name.is_empty() || name.len() > 128 {
            return Err(DriverError::invalid("Invalid connection name"));
        }
        if connections.contains_key(name) {
            return Err(DriverError::invalid(format!(
                "The connection {name} is already open"
            )));
        }
        if connections.len() >= limits::CONNECTIONS {
            return Err(DriverError::invalid(format!(
                "There are already {} database connections open; close one first",
                limits::CONNECTIONS
            )));
        }
        connections.insert(name.to_owned(), connection);
        Ok(())
    }
    pub fn close(&self, name: &str) -> Option<Connection> {
        self.0.lock().unwrap().remove(name)
    }
    /// The module and process of a connection, marking it as used now.
    pub fn touch(&self, name: &str) -> Option<(String, u64)> {
        let mut connections = self.0.lock().unwrap();
        let connection = connections.get_mut(name)?;
        connection.last_used = Instant::now();
        Some((connection.module.clone(), connection.generation))
    }
    /// The secrets of a connection of `module` that are limited to some hosts.
    pub fn secret_hosts(&self, name: &str, module: &str) -> Option<SecretHosts> {
        let connections = self.0.lock().unwrap();
        let connection = connections.get(name).filter(|c| c.module == module)?;
        Some(connection.secret_hosts.clone())
    }
    pub fn count(&self, module: &str) -> usize {
        let connections = self.0.lock().unwrap();
        connections.values().filter(|c| c.module == module).count()
    }
    /// Forgets the connections of a process that stopped.
    pub fn forget_process(&self, module: &str, generation: u64) {
        self.0
            .lock()
            .unwrap()
            .retain(|_, c| c.module != module || c.generation != generation);
    }
    /// Takes out the connections nobody used for `idle`, with their module.
    pub fn take_idle(&self, idle: Duration) -> Vec<(String, String)> {
        let mut connections = self.0.lock().unwrap();
        let names: Vec<String> = connections
            .iter()
            .filter(|(_, connection)| connection.last_used.elapsed() >= idle)
            .map(|(name, _)| name.clone())
            .collect();
        names
            .into_iter()
            .filter_map(|name| {
                let connection = connections.remove(&name)?;
                Some((name, connection.module))
            })
            .collect()
    }
}
