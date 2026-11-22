//! A connection to Redis or Valkey (DB-35): one server, the master a set of Sentinels names,
//! or a cluster. Every address the library connects to, the cluster's nodes included, is
//! asked of the host (`net.resolve`), so the egress policy decides each one.
use nexo_driver_sdk::{DriverError, HostLink, Result, limits};
use redis::{
    AsyncConnectionConfig, Client, ConnectionInfo, ProtocolVersion, TlsCertificates,
    aio::MultiplexedConnection,
    cluster::{ClusterClient, ClusterClientBuilder},
    cluster_async::ClusterConnection,
    io::AsyncDNSResolver,
};
use std::net::SocketAddr;

mod tls;

/// The port of a server without one.
pub(crate) const PORT: u16 = 6379;
/// The settings a Redis connection accepts, besides the common ones.
pub const SETTINGS: [&str; 2] = ["mode", "master"];

/// Names are resolved by the host, which applies the egress policy.
#[derive(Clone)]
pub(crate) struct HostResolver {
    link: HostLink,
    connection: String,
}

impl AsyncDNSResolver for HostResolver {
    fn resolve<'a, 'b: 'a>(
        &'a self,
        host: &'b str,
        port: u16,
    ) -> redis::RedisFuture<'a, Box<dyn Iterator<Item = SocketAddr> + Send + 'a>> {
        Box::pin(async move {
            let addresses = self
                .link
                .resolve(&self.connection, host, port)
                .await
                .map_err(|error| redis::RedisError::from(std::io::Error::other(error.message)))?;
            Ok(Box::new(addresses.into_iter()) as Box<dyn Iterator<Item = SocketAddr> + Send>)
        })
    }
}

/// The open connection: one server's, or the cluster's.
#[derive(Clone)]
pub(crate) enum Conn {
    Single(MultiplexedConnection),
    Cluster(ClusterConnection),
}

impl Conn {
    pub(crate) async fn run(&self, command: &redis::Cmd) -> redis::RedisResult<redis::Value> {
        match self {
            Self::Single(connection) => command.query_async(&mut connection.clone()).await,
            Self::Cluster(connection) => command.query_async(&mut connection.clone()).await,
        }
    }
}

/// Where the server's pushes go (the messages of a subscription).
pub(crate) type Pushed = tokio::sync::mpsc::UnboundedSender<redis::PushInfo>;

/// How to open one more connection to the same place: a subscription needs its own.
#[derive(Clone)]
pub(crate) struct Target {
    /// The server (the master of a Sentinel set), or the cluster's first nodes.
    pub infos: Vec<ConnectionInfo>,
    pub certificates: Option<TlsCertificates>,
    pub cluster: bool,
    pub resolver: HostResolver,
}

impl Target {
    fn config(&self) -> AsyncConnectionConfig {
        AsyncConnectionConfig::new()
            .set_dns_resolver(self.resolver.clone())
            .set_connection_timeout(Some(limits::connect()))
            .set_response_timeout(Some(limits::STATEMENT))
    }

    fn client(&self, info: ConnectionInfo) -> redis::RedisResult<Client> {
        match &self.certificates {
            Some(certificates) => Client::build_with_tls(info, certificates.clone()),
            None => Client::open(info),
        }
    }

    fn cluster(&self, protocol: ProtocolVersion) -> redis::RedisResult<ClusterClientBuilder> {
        let infos: Vec<ConnectionInfo> = self
            .infos
            .iter()
            .map(|info| {
                let settings = info.redis_settings().clone().set_protocol(protocol);
                info.clone().set_redis_settings(settings)
            })
            .collect();
        let mut builder = ClusterClient::builder(infos)
            .async_dns_resolver(self.resolver.clone())
            .connection_timeout(limits::connect())
            .response_timeout(limits::STATEMENT)
            .use_protocol(protocol);
        if let Some(certificates) = &self.certificates {
            builder = builder.certs(certificates.clone());
        }
        Ok(builder)
    }

    /// Opens a connection; `push` receives what the server pushes (RESP3: the messages of
    /// a subscription).
    pub(crate) async fn open(&self, push: Option<Pushed>) -> Result<Conn> {
        if self.cluster {
            let mut builder = self.cluster(protocol(push.is_some())).map_err(failure)?;
            if let Some(push) = push {
                builder = builder.push_sender(push);
            }
            let client = builder.build().map_err(failure)?;
            return Ok(Conn::Cluster(
                client.get_async_connection().await.map_err(failure)?,
            ));
        }
        let info = self
            .infos
            .first()
            .cloned()
            .ok_or_else(|| DriverError::invalid("The connection names no server"))?;
        let settings = info
            .redis_settings()
            .clone()
            .set_protocol(protocol(push.is_some()));
        let client = self
            .client(info.set_redis_settings(settings))
            .map_err(failure)?;
        let mut config = self.config();
        if let Some(push) = push {
            config = config.set_push_sender(push);
        }
        let connection = client
            .get_multiplexed_async_connection_with_config(&config)
            .await
            .map_err(failure)?;
        Ok(Conn::Single(connection))
    }
}

fn protocol(push: bool) -> ProtocolVersion {
    if push {
        ProtocolVersion::RESP3
    } else {
        ProtocolVersion::RESP2
    }
}

/// The servers written in the host field: `a,b:6380`, each one with its port.
pub(crate) fn servers(host: &str, port: Option<u16>) -> Vec<(String, u16)> {
    host.split(',')
        .map(str::trim)
        .filter(|server| !server.is_empty())
        .map(|server| match server.rsplit_once(':') {
            Some((name, number)) if !name.contains(':') || name.ends_with(']') => (
                name.trim_matches(['[', ']']).to_owned(),
                number.parse().unwrap_or(port.unwrap_or(PORT)),
            ),
            _ => (
                server.trim_matches(['[', ']']).to_owned(),
                port.unwrap_or(PORT),
            ),
        })
        .collect()
}

pub(crate) fn failure(error: impl std::fmt::Display) -> DriverError {
    let message = error.to_string();
    let lower = message.to_ascii_lowercase();
    if lower.contains("wrongpass") || lower.contains("noauth") || lower.contains("invalid password")
    {
        DriverError::auth(message)
    } else if lower.contains("noperm") {
        DriverError::permission(message)
    } else if lower.contains("timed out") || lower.contains("timeout") {
        DriverError::timeout(message)
    } else if lower.contains("connect")
        || lower.contains("refused")
        || lower.contains("broken pipe")
        || lower.contains("io error")
        || lower.contains("egress policy")
    {
        DriverError::network(message)
    } else {
        DriverError::invalid(message)
    }
}

mod open;
pub(crate) use open::open;
