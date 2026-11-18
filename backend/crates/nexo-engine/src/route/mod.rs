//! How the engine reaches a destination: directly, through an HTTP proxy (`CONNECT`) or a
//! SOCKS5 proxy, with the name resolved here or by the proxy. Every protocol dials through a
//! [`Dialer`]; once the proxy has answered, the connection is a plain TCP stream, so TLS and
//! the protocols above it stay as they are. HTTP requests take the same route as reqwest's
//! proxy ([`Route::proxy_url`]).

mod handshake;

use crate::egress::Policy;
use nexo_domain::{Error, Result};
use serde_json::Value;
use std::net::SocketAddr;
use tokio::net::TcpStream;

/// Where a proxy listens.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Endpoint {
    pub host: String,
    pub port: u16,
}

/// The user name and password a proxy asks for.
#[derive(Clone, PartialEq, Eq)]
pub struct Credentials {
    pub username: String,
    pub password: String,
}
impl std::fmt::Debug for Credentials {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "Credentials({}, ••••••)", self.username)
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub enum Route {
    #[default]
    Direct,
    /// An HTTP proxy: plain requests go to it, the rest through `CONNECT`.
    Http {
        proxy: Endpoint,
        credentials: Option<Credentials>,
    },
    /// A SOCKS5 proxy; with `remote_dns` (`socks5h`) the proxy resolves the name.
    Socks5 {
        proxy: Endpoint,
        credentials: Option<Credentials>,
        remote_dns: bool,
    },
}

fn text(value: &Value) -> String {
    match value {
        Value::String(text) => text.trim().to_string(),
        Value::Number(number) => number.to_string(),
        _ => String::new(),
    }
}

impl Route {
    /// From transport settings: `route` (`{via, host, port, username, password, remoteDns}`,
    /// `via` being `direct`, `http`, `socks5`), or the older `proxy` (`{protocol, host, port,
    /// username, password, uri, disabled}`) that requests saved before routes still have.
    pub fn from_settings(settings: &Value) -> Result<Self> {
        let route = &settings["route"];
        if route.is_object() {
            let via = text(&route["via"]);
            return Self::build(
                &via,
                &route["host"],
                &route["port"],
                &route["username"],
                &route["password"],
                route["remoteDns"] == true,
            );
        }
        let proxy = &settings["proxy"];
        if !proxy.is_object() || proxy["disabled"] == true {
            return Ok(Self::Direct);
        }
        if let Some(uri) = proxy["uri"].as_str().filter(|uri| !uri.trim().is_empty()) {
            let url = url::Url::parse(uri.trim())
                .map_err(|_| Error::Validation(format!("Invalid proxy: {uri}")))?;
            let remote = url.scheme() == "socks5h";
            let via = if url.scheme().starts_with("socks5") {
                "socks5"
            } else {
                "http"
            };
            return Self::build(
                via,
                &Value::String(url.host_str().unwrap_or_default().to_string()),
                &url.port_or_known_default().map_or(Value::Null, Value::from),
                &proxy["username"],
                &proxy["password"],
                remote,
            );
        }
        let protocol = text(&proxy["protocol"]);
        let via = if protocol.starts_with("socks5") {
            "socks5"
        } else {
            "http"
        };
        Self::build(
            via,
            &proxy["host"],
            &proxy["port"],
            &proxy["username"],
            &proxy["password"],
            protocol == "socks5h",
        )
    }

    fn build(
        via: &str,
        host: &Value,
        port: &Value,
        username: &Value,
        password: &Value,
        remote_dns: bool,
    ) -> Result<Self> {
        if matches!(via, "" | "direct") {
            return Ok(Self::Direct);
        }
        let host = text(host);
        if host.is_empty() {
            return Err(Error::Validation("Enter the host of the proxy".into()));
        }
        let default = if via == "socks5" { 1080 } else { 8080 };
        let port = match text(port).as_str() {
            "" => default,
            port => port
                .parse::<u16>()
                .ok()
                .filter(|port| *port > 0)
                .ok_or_else(|| Error::Validation(format!("Invalid proxy port {port}")))?,
        };
        let proxy = Endpoint { host, port };
        let username = text(username);
        let credentials = (!username.is_empty()).then(|| Credentials {
            username,
            password: password.as_str().unwrap_or_default().to_string(),
        });
        match via {
            "http" => Ok(Self::Http { proxy, credentials }),
            "socks5" => Ok(Self::Socks5 {
                proxy,
                credentials,
                remote_dns,
            }),
            other => Err(Error::Validation(format!(
                "Unknown way to connect: {other}"
            ))),
        }
    }

    /// The proxy of reqwest for HTTP requests, without credentials (see [`Self::credentials`]).
    pub fn proxy_url(&self) -> Option<String> {
        match self {
            Self::Direct => None,
            Self::Http { proxy, .. } => Some(format!("http://{}", authority(proxy))),
            Self::Socks5 {
                proxy, remote_dns, ..
            } => Some(format!(
                "{}://{}",
                if *remote_dns { "socks5h" } else { "socks5" },
                authority(proxy)
            )),
        }
    }
    pub fn credentials(&self) -> Option<&Credentials> {
        match self {
            Self::Direct => None,
            Self::Http { credentials, .. } | Self::Socks5 { credentials, .. } => {
                credentials.as_ref()
            }
        }
    }
    pub fn proxy(&self) -> Option<&Endpoint> {
        match self {
            Self::Direct => None,
            Self::Http { proxy, .. } | Self::Socks5 { proxy, .. } => Some(proxy),
        }
    }
}

/// `host:port`, with brackets around an IPv6 address.
pub(crate) fn authority(endpoint: &Endpoint) -> String {
    if endpoint.host.contains(':') && !endpoint.host.starts_with('[') {
        format!("[{}]:{}", endpoint.host, endpoint.port)
    } else {
        format!("{}:{}", endpoint.host, endpoint.port)
    }
}

/// Connects to destinations by a route, within the egress policy: the proxy Nexo connects to
/// and the final destination both pass it.
#[derive(Clone, Debug)]
pub struct Dialer {
    pub route: Route,
    pub egress: Policy,
    pub loopback_ports: Vec<u16>,
}
impl Dialer {
    pub fn new(route: Route, egress: Policy, loopback_ports: Vec<u16>) -> Self {
        Self {
            route,
            egress,
            loopback_ports,
        }
    }
    /// Checks the destination before connecting, so a refusal is answered at once. Direct,
    /// it returns the addresses to connect to; through a proxy, the proxy's.
    pub async fn check(&self, host: &str, port: u16) -> Result<Vec<SocketAddr>> {
        let Some(proxy) = self.route.proxy() else {
            return self.egress.resolve(host, port, &self.loopback_ports).await;
        };
        if let Route::Socks5 {
            remote_dns: false, ..
        } = self.route
        {
            self.egress
                .resolve(host, port, &self.loopback_ports)
                .await?;
        } else {
            self.egress
                .check_remote(host, port, &self.loopback_ports)
                .await?;
        }
        self.egress
            .resolve(&proxy.host, proxy.port, &self.loopback_ports)
            .await
    }
    /// A TCP stream to `host:port`: the destination's own, or the proxy's once it relays.
    pub async fn connect(&self, host: &str, port: u16) -> Result<TcpStream> {
        let addresses = self.check(host, port).await?;
        let stream = TcpStream::connect(&addresses[..]).await.map_err(|error| {
            let to = self.route.proxy().map_or_else(
                || format!("{host}:{port}"),
                |proxy| format!("the proxy {}", authority(proxy)),
            );
            Error::Validation(format!("Cannot connect to {to}: {error}"))
        })?;
        let _ = stream.set_nodelay(true);
        match &self.route {
            Route::Direct => Ok(stream),
            Route::Http { credentials, .. } => {
                handshake::http_connect(stream, host, port, credentials.as_ref()).await
            }
            Route::Socks5 {
                credentials,
                remote_dns,
                ..
            } => {
                let target = if *remote_dns {
                    None
                } else {
                    self.egress
                        .resolve(host, port, &self.loopback_ports)
                        .await?
                        .first()
                        .copied()
                };
                handshake::socks5(stream, host, port, target, credentials.as_ref()).await
            }
        }
    }
}

#[cfg(test)]
mod tests;
