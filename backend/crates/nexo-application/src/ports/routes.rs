//! How a connection of an adapter reaches its servers: directly, or through a SOCKS5 proxy
//! that is either the route's own or the local end of an SSH tunnel. The engine opens the
//! tunnels; adapters that connect on their own (MongoDB, database drivers) ask for them here.
use nexo_domain::{Error, Result};
use serde_json::Value;

/// A SOCKS5 proxy a connection goes through. Its host is an address already allowed by the
/// egress policy (or the loopback end of a tunnel), so what was checked is what is reached.
#[derive(Clone, PartialEq, Eq)]
pub struct SocksProxy {
    pub host: String,
    pub port: u16,
    /// User and password of the proxy, when it asks for them.
    pub credentials: Option<(String, String)>,
}
impl std::fmt::Debug for SocksProxy {
    /// Never shows the password.
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("SocksProxy")
            .field("host", &self.host)
            .field("port", &self.port)
            .field(
                "credentials",
                &self
                    .credentials
                    .as_ref()
                    .map(|(user, _)| (user, "[redacted]")),
            )
            .finish()
    }
}

/// The route of a connection (`{via, host, port, username, password, profile}`) and the SSH
/// profiles it names, with their secrets, as the application filled them in.
#[derive(Clone, Default, PartialEq)]
pub struct ConnectionRoute {
    pub route: Value,
    pub profiles: Value,
}
impl ConnectionRoute {
    /// Whether the connection goes straight to its servers.
    pub fn is_direct(&self) -> bool {
        matches!(self.route["via"].as_str(), None | Some("direct"))
    }
}
impl std::fmt::Debug for ConnectionRoute {
    /// Shows the way, never a password or a key.
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("ConnectionRoute")
            .field("via", &self.route["via"])
            .finish_non_exhaustive()
    }
}

/// Answer of a policy that cannot route connections (tests, tools without an engine).
pub fn unrouted(route: &ConnectionRoute) -> Result<Option<SocksProxy>> {
    if route.is_direct() {
        Ok(None)
    } else {
        Err(Error::Validation(
            "Connections cannot go through a proxy or an SSH tunnel here".into(),
        ))
    }
}
