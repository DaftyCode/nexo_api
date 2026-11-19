//! The dialer: connects to destinations by a route, within the egress policy. The proxy or
//! SSH server Nexo connects to and the final destination both pass it.
use super::{Credentials, Endpoint, Route, authority, handshake, ssh};
use crate::egress::Policy;
use nexo_application::ports::SocksProxy;
use nexo_domain::{Error, Result};
use std::net::{Ipv4Addr, SocketAddr};
use tokio::net::TcpStream;

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

    /// The proxy reqwest takes for HTTP requests, with its credentials: the route's own, or
    /// the loopback SOCKS5 proxy of an SSH tunnel (listening from now on; its session opens
    /// when [`Self::check`] first needs it).
    pub fn http_proxy(&self) -> Result<Option<(String, Option<Credentials>)>> {
        if let Route::Ssh(target) = &self.route {
            let tunnel = ssh::tunnels().tunnel(target, &self.egress, &self.loopback_ports)?;
            return Ok(Some((
                format!("socks5h://{}", authority(&tunnel.endpoint())),
                Some(tunnel.credentials()),
            )));
        }
        Ok(self
            .route
            .proxy_url()
            .map(|url| (url, self.route.credentials().cloned())))
    }

    /// The SOCKS5 proxy for adapters that connect on their own (MongoDB, database drivers):
    /// the route's own, at an address the egress policy allows, or the loopback end of the
    /// SSH tunnel with its session open. `None` when direct; HTTP proxies are refused.
    pub async fn socks_proxy(&self) -> Result<Option<SocksProxy>> {
        let pair = |credentials: Credentials| (credentials.username, credentials.password);
        match &self.route {
            Route::Direct => Ok(None),
            Route::Http { .. } => Err(Error::Validation(
                "This connection cannot go through an HTTP proxy: choose a SOCKS5 proxy or an SSH tunnel"
                    .into(),
            )),
            Route::Socks5 {
                proxy, credentials, ..
            } => {
                let addresses = self
                    .egress
                    .resolve(&proxy.host, proxy.port, &self.loopback_ports)
                    .await?;
                let address = addresses.first().ok_or_else(|| {
                    Error::Validation(format!("Cannot resolve {}", proxy.host))
                })?;
                Ok(Some(SocksProxy {
                    host: address.ip().to_string(),
                    port: address.port(),
                    credentials: credentials.clone().map(pair),
                }))
            }
            Route::Ssh(target) => {
                let tunnel = ssh::tunnels().tunnel(target, &self.egress, &self.loopback_ports)?;
                tunnel.ensure().await?;
                Ok(Some(SocksProxy {
                    host: Ipv4Addr::LOCALHOST.to_string(),
                    port: tunnel.port,
                    credentials: Some(pair(tunnel.credentials())),
                }))
            }
        }
    }

    /// Checks the destination before connecting, so a refusal is answered at once. Direct,
    /// it returns the addresses to connect to; through a proxy, the proxy's; through SSH,
    /// the tunnel's loopback port once its session is open.
    pub async fn check(&self, host: &str, port: u16) -> Result<Vec<SocketAddr>> {
        match &self.route {
            Route::Direct => self.egress.resolve(host, port, &self.loopback_ports).await,
            Route::Ssh(target) => {
                let tunnel = ssh::tunnels().tunnel(target, &self.egress, &self.loopback_ports)?;
                tunnel.ensure().await?;
                self.egress
                    .check_remote(host, port, &self.loopback_ports)
                    .await?;
                Ok(vec![SocketAddr::from((Ipv4Addr::LOCALHOST, tunnel.port))])
            }
            Route::Http { proxy, .. } | Route::Socks5 { proxy, .. } => {
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
        }
    }

    /// A TCP stream to `host:port`: the destination's own, or the proxy's once it relays.
    pub async fn connect(&self, host: &str, port: u16) -> Result<TcpStream> {
        let addresses = self.check(host, port).await?;
        let stream = TcpStream::connect(&addresses[..]).await.map_err(|error| {
            let to = match &self.route {
                Route::Direct => format!("{host}:{port}"),
                Route::Ssh(target) => format!("the SSH tunnel of {}", target.host),
                Route::Http { proxy, .. } | Route::Socks5 { proxy, .. } => {
                    format!("the proxy {}", authority(proxy))
                }
            };
            Error::Validation(format!("Cannot connect to {to}: {error}"))
        })?;
        let _ = stream.set_nodelay(true);
        match &self.route {
            Route::Direct => Ok(stream),
            Route::Http { credentials, .. } => {
                handshake::http_connect(stream, host, port, credentials.as_ref()).await
            }
            Route::Ssh(target) => {
                let tunnel = ssh::tunnels().tunnel(target, &self.egress, &self.loopback_ports)?;
                let credentials = tunnel.credentials();
                handshake::socks5(stream, host, port, None, Some(&credentials)).await
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

/// Where a tunnel listens, as an endpoint.
pub(super) fn loopback(port: u16) -> Endpoint {
    Endpoint {
        host: Ipv4Addr::LOCALHOST.to_string(),
        port,
    }
}
