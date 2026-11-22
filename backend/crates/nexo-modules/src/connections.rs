//! The connections open in the drivers: which process each one lives in, the secrets that
//! may only reach some hosts, and when it was last used.
use nexo_application::ports::{ConnectionRoute, Forwarded};
use nexo_domain::hosts::AllowedHosts;
use nexo_driver_sdk::{DriverError, Result, limits};
use serde::Serialize;
use std::{
    collections::{HashMap, VecDeque},
    net::SocketAddr,
    sync::Mutex,
    time::{Duration, Instant},
};

/// Vault secrets of a connection that may only reach some hosts, by name.
pub(crate) type SecretHosts = Vec<(String, AllowedHosts)>;

/// How the host keeps a connection besides what its driver is told: where its secrets may
/// go, how it reaches its servers, how long it stays open unused and how it is kept alive.
#[derive(Clone, Default)]
pub struct ConnectionSettings {
    pub secret_hosts: Vec<(String, AllowedHosts)>,
    pub route: ConnectionRoute,
    /// Shorter than the host's own time, when set.
    pub idle: Option<Duration>,
    /// The query and how often it runs while the connection is not used.
    pub keep_alive: Option<(Duration, String)>,
}
impl ConnectionSettings {
    /// Only the secrets limited to some hosts.
    pub fn hosts(secret_hosts: Vec<(String, AllowedHosts)>) -> Self {
        Self {
            secret_hosts,
            ..Self::default()
        }
    }
}

/// The servers a connection may record: a driver asks for one or a few.
const DESTINATIONS: usize = 16;

/// A server a driver asked to reach for a connection, and what the egress policy said.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Destination {
    pub host: String,
    pub port: u16,
    pub allowed: bool,
    /// The addresses it may use, when allowed.
    pub addresses: Vec<String>,
    /// Why it was refused.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

pub(crate) struct Connection {
    pub module: String,
    /// The start of the driver process it lives in: a later process does not have it.
    pub generation: u64,
    pub secret_hosts: SecretHosts,
    pub last_used: Instant,
    pub destinations: Vec<Destination>,
    /// A transaction is open in it: it is never closed for being idle (the person is told).
    pub held: bool,
    /// How it reaches its servers; when not direct, the host forwards a loopback port for
    /// each server the driver asks for (DB-25).
    pub route: ConnectionRoute,
    /// The forwarded ports, by server: closed with the connection.
    pub forwards: Vec<(String, u16, Forwarded)>,
    /// Its own time unused before it is closed, when shorter than the host's.
    pub idle: Option<Duration>,
    pub keep_alive: Option<(Duration, String)>,
    /// When its keep-alive query last ran: it does not count as a use.
    pub pinged: Instant,
}

/// Names of connections the host closed by itself, remembered at most.
const GONE: usize = 64;

#[derive(Default)]
pub(crate) struct Connections {
    open: Mutex<HashMap<String, Connection>>,
    /// Connections the host closed by itself (unused, or their driver stopped): their next
    /// use is told they closed, so the application can open them again.
    gone: Mutex<VecDeque<String>>,
}
impl Connections {
    /// Registers a connection before its driver is asked to open it, so the driver's
    /// questions about it can be answered.
    pub fn open(&self, name: &str, connection: Connection) -> Result<()> {
        let mut connections = self.open.lock().unwrap();
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
        self.gone.lock().unwrap().retain(|known| known != name);
        Ok(())
    }
    pub fn close(&self, name: &str) -> Option<Connection> {
        self.open.lock().unwrap().remove(name)
    }
    /// The module and process of a connection, marking it as used now.
    pub fn touch(&self, name: &str) -> Option<(String, u64)> {
        let mut connections = self.open.lock().unwrap();
        let connection = connections.get_mut(name)?;
        connection.last_used = Instant::now();
        Some((connection.module.clone(), connection.generation))
    }
    /// The module and process of a connection, without marking it as used.
    pub fn peek(&self, name: &str) -> Option<(String, u64)> {
        let connections = self.open.lock().unwrap();
        let connection = connections.get(name)?;
        Some((connection.module.clone(), connection.generation))
    }
    /// The secrets of a connection of `module` that are limited to some hosts, and its route.
    pub fn secret_hosts(&self, name: &str, module: &str) -> Option<(SecretHosts, ConnectionRoute)> {
        let connections = self.open.lock().unwrap();
        let connection = connections.get(name).filter(|c| c.module == module)?;
        Some((connection.secret_hosts.clone(), connection.route.clone()))
    }
    /// The loopback address already forwarded to `host:port` for a connection.
    pub fn forwarded(&self, name: &str, host: &str, port: u16) -> Option<SocketAddr> {
        let connections = self.open.lock().unwrap();
        connections
            .get(name)?
            .forwards
            .iter()
            .find(|(known, at, _)| known == host && *at == port)
            .map(|(_, _, forward)| forward.address)
    }
    /// Keeps a forwarded port with its connection, once per server; when the connection is
    /// gone (closed while the port opened), the port closes at once.
    pub fn keep_forward(
        &self,
        name: &str,
        host: &str,
        port: u16,
        forward: Forwarded,
    ) -> SocketAddr {
        let mut connections = self.open.lock().unwrap();
        let Some(connection) = connections.get_mut(name) else {
            return forward.address;
        };
        if let Some((_, _, known)) = connection
            .forwards
            .iter()
            .find(|(known, at, _)| known == host && *at == port)
        {
            return known.address;
        }
        let address = forward.address;
        if connection.forwards.len() < DESTINATIONS {
            connection.forwards.push((host.to_owned(), port, forward));
        }
        address
    }
    /// Records a server a connection's driver asked for; the same server once, the latest.
    pub fn record(&self, name: &str, destination: Destination) {
        let mut connections = self.open.lock().unwrap();
        let Some(connection) = connections.get_mut(name) else {
            return;
        };
        let list = &mut connection.destinations;
        list.retain(|known| known.host != destination.host || known.port != destination.port);
        if list.len() < DESTINATIONS {
            list.push(destination);
        }
    }
    /// Keeps a connection open while it has a transaction, however long it is not used.
    pub fn hold(&self, name: &str, held: bool) {
        if let Some(connection) = self.open.lock().unwrap().get_mut(name) {
            connection.held = held;
        }
    }
    pub fn count(&self, module: &str) -> usize {
        let connections = self.open.lock().unwrap();
        connections.values().filter(|c| c.module == module).count()
    }
    /// Forgets the connections of a process that stopped.
    pub fn forget_process(&self, module: &str, generation: u64) {
        let mut connections = self.open.lock().unwrap();
        let mut gone = Vec::new();
        connections.retain(|name, c| {
            let keep = c.module != module || c.generation != generation;
            if !keep {
                gone.push(name.clone());
            }
            keep
        });
        drop(connections);
        self.remember(gone);
    }
    /// The connections whose keep-alive query is due, with their module, process and query;
    /// marked as pinged now. A connection used lately needs none.
    pub fn due_pings(&self) -> Vec<(String, String, u64, String)> {
        let mut connections = self.open.lock().unwrap();
        connections
            .iter_mut()
            .filter_map(|(name, connection)| {
                let (every, query) = connection.keep_alive.clone()?;
                let quiet = connection
                    .last_used
                    .elapsed()
                    .min(connection.pinged.elapsed());
                (quiet >= every).then(|| {
                    connection.pinged = Instant::now();
                    let module = connection.module.clone();
                    (name.clone(), module, connection.generation, query)
                })
            })
            .collect()
    }
    /// Takes out the connections nobody used for `idle` (or their own shorter time), with
    /// their module.
    pub fn take_idle(&self, idle: Duration) -> Vec<(String, String)> {
        let mut connections = self.open.lock().unwrap();
        let names: Vec<String> = connections
            .iter()
            .filter(|(_, connection)| {
                let limit = connection.idle.map_or(idle, |own| own.min(idle));
                !connection.held && connection.last_used.elapsed() >= limit
            })
            .map(|(name, _)| name.clone())
            .collect();
        let closed: Vec<(String, String)> = names
            .into_iter()
            .filter_map(|name| {
                let connection = connections.remove(&name)?;
                Some((name, connection.module))
            })
            .collect();
        drop(connections);
        self.remember(closed.iter().map(|(name, _)| name.clone()).collect());
        closed
    }
    fn remember(&self, names: Vec<String>) {
        let mut gone = self.gone.lock().unwrap();
        for name in names {
            gone.retain(|known| known != &name);
            if gone.len() == GONE {
                gone.pop_front();
            }
            gone.push_back(name);
        }
    }
    /// Whether the host closed this connection by itself, rather than it never being open.
    pub fn was_closed(&self, name: &str) -> bool {
        self.gone.lock().unwrap().iter().any(|known| known == name)
    }
}
