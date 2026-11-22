//! MongoDB as a module (DB-39): the application's document database port, each call sent to
//! the MongoDB driver as a method of the `document` extension. The application (its rules,
//! `nx.mongo`, the shell, MCP, comparisons) does not know MongoDB left the process.
//!
//! A connection reaches the adapter with its secrets on every call; it becomes one driver
//! connection, kept while it is used (closed by the host after a while unused, and opened
//! again when needed), identified by everything that identifies it, as the built-in adapter
//! kept its clients. Cursors, running queries and change streams are named by the driver;
//! the adapter remembers which connection holds each one.
mod answers;
mod convert;
mod port;
mod routes;

use crate::{ConnectionSettings, host::DriverHost};
use nexo_application::ports::DatabaseConnection;
use nexo_domain::{Error, Result};
use nexo_driver_sdk::{
    DriverError, ErrorCode,
    document::{On, options},
    protocol::{ConnectParams, ProxySettings, TlsSettings},
};
use routes::Routes;
use serde::{Serialize, de::DeserializeOwned};
use std::{collections::HashMap, time::Duration, time::Instant};

/// The module of the driver.
pub const MODULE: &str = "mongodb";
/// Connections kept open at once; the one unused for longest is closed for a new one.
const CLIENTS: usize = 8;
/// How long a connection nobody uses stays open, as the built-in adapter kept its clients.
const IDLE: Duration = Duration::from_secs(10 * 60);
/// How long the host waits for an answer: the driver's own operation limit (60 s, and its
/// margin) answers first.
const ANSWER: Duration = Duration::from_secs(75);

/// A driver connection kept for a connection of the application.
struct Session {
    name: String,
    used: Instant,
}

/// The MongoDB module behind the document database port.
pub struct Documents {
    host: DriverHost,
    sessions: tokio::sync::Mutex<HashMap<String, Session>>,
    routes: Routes,
}

/// An error of the driver or of the host as the application answers it: what the person
/// reads, as the built-in adapter wrote it.
fn error(error: DriverError) -> Error {
    match error.code {
        ErrorCode::Internal => Error::Infrastructure(error.message),
        ErrorCode::Unsupported if error.message.contains("module is not installed") => {
            Error::Validation(
                "MongoDB is now a downloadable module, and it is not installed: open a MongoDB connection in Databases to download it"
                    .into(),
            )
        }
        _ => Error::Validation(error.message),
    }
}

impl Documents {
    pub fn new(host: DriverHost) -> Self {
        Self {
            host,
            sessions: Default::default(),
            routes: Routes::default(),
        }
    }

    /// The driver connection of a connection, opened when there is none (or the host closed
    /// it). Opening it checks every server with the egress policy.
    async fn session(&self, connection: &DatabaseConnection) -> Result<String> {
        let network = self.host.network();
        // The proxy is part of what identifies it: an SSH tunnel reopened after a while
        // listens on another port, with another password.
        let proxy = network.socks_proxy(&connection.route).await?;
        let key = format!(
            "{}\0{:?}\0{:?}\0{:?}\0{:?}\0{:?}\0{:?}\0{}\0{}",
            connection.uri,
            connection.password,
            connection.ca_pem,
            connection.cert_pem,
            connection.key_pem,
            connection.secret_hosts,
            proxy.as_ref().map(|p| (&p.host, p.port, &p.credentials)),
            connection.route.route,
            connection.route.profiles,
        );
        let mut sessions = self.sessions.lock().await;
        if let Some(session) = sessions.get_mut(&key) {
            if self.host.is_open(&session.name).await {
                session.used = Instant::now();
                return Ok(session.name.clone());
            }
            sessions.remove(&key);
        }
        if sessions.len() >= CLIENTS {
            self.close_oldest(&mut sessions).await;
        }
        let name = format!("mongo-{}", uuid::Uuid::new_v4().simple());
        let check_members = network.restrictive() || !connection.secret_hosts.is_empty();
        self.open(&name, connection, proxy, check_members).await?;
        sessions.insert(
            key,
            Session {
                name: name.clone(),
                used: Instant::now(),
            },
        );
        Ok(name)
    }

    /// Closes the connection unused for longest, unless it follows change streams.
    async fn close_oldest(&self, sessions: &mut HashMap<String, Session>) {
        let oldest = sessions
            .iter()
            .filter(|(_, session)| !self.routes.watching(&session.name))
            .min_by_key(|(_, session)| session.used)
            .map(|(key, _)| key.clone());
        if let Some(session) = oldest.and_then(|key| sessions.remove(&key)) {
            let _ = self.host.disconnect(&session.name).await;
        }
    }

    /// Opens a driver connection named `name`.
    async fn open(
        &self,
        name: &str,
        connection: &DatabaseConnection,
        proxy: Option<nexo_application::ports::SocksProxy>,
        check_members: bool,
    ) -> Result<()> {
        let mut params = ConnectParams {
            connection: name.to_owned(),
            password: connection.password.clone(),
            tls: TlsSettings {
                ca_pem: connection.ca_pem.clone(),
                cert_pem: connection.cert_pem.clone(),
                key_pem: connection.key_pem.clone(),
                ..TlsSettings::default()
            },
            proxy: proxy.map(|proxy| {
                let (user, password) = proxy.credentials.unzip();
                ProxySettings {
                    host: proxy.host,
                    port: proxy.port,
                    user,
                    password,
                }
            }),
            ..ConnectParams::default()
        };
        params
            .options
            .insert(options::URI.into(), connection.uri.clone());
        if check_members {
            params
                .options
                .insert(options::CHECK_MEMBERS.into(), "true".into());
        }
        let settings = ConnectionSettings {
            secret_hosts: connection.secret_hosts.clone(),
            route: connection.route.clone(),
            idle: Some(IDLE),
            keep_alive: None,
        };
        self.host
            .connect(MODULE, params, settings)
            .await
            .map(|_| ())
            .map_err(error)
    }

    /// A method of the extension on a driver connection.
    async fn call<P: Serialize + Sync, R: DeserializeOwned>(
        &self,
        session: &str,
        method: &str,
        request: P,
    ) -> Result<R> {
        let on = On {
            connection: session.to_owned(),
            request,
        };
        self.host
            .call_within(session, method, &on, Some(ANSWER))
            .await
            .map_err(error)
    }

    /// A method on the connection of `connection`, opened if needed.
    async fn on<P: Serialize + Sync, R: DeserializeOwned>(
        &self,
        connection: &DatabaseConnection,
        method: &str,
        request: P,
    ) -> Result<R> {
        let session = self.session(connection).await?;
        self.call(&session, method, request).await
    }

    /// The open connection that holds what the driver named `id`, or any open one: the
    /// driver keeps cursors and change streams for the whole process.
    async fn holder(&self, id: &str) -> Option<String> {
        if let Some(session) = self.routes.of(id)
            && self.host.is_open(&session).await
        {
            return Some(session);
        }
        let names: Vec<String> = self
            .sessions
            .lock()
            .await
            .values()
            .map(|session| session.name.clone())
            .collect();
        for name in names {
            if self.host.is_open(&name).await {
                return Some(name);
            }
        }
        None
    }
}

#[cfg(test)]
mod tests;
