//! How the engine reaches a destination: directly, through an HTTP proxy (`CONNECT`), a
//! SOCKS5 proxy (the name resolved here or by the proxy) or an SSH tunnel. Every protocol
//! dials through a [`Dialer`]; once the proxy has answered, the connection is a plain TCP
//! stream, so TLS and the protocols above it stay as they are. HTTP requests take the same
//! route as reqwest's proxy ([`Dialer::http_proxy`]).

mod dialer;
pub mod forward;
mod handshake;
pub mod ssh;

pub use dialer::Dialer;
use nexo_domain::{Error, Result};
use serde_json::Value;
use ssh::SshTarget;

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
    /// An SSH tunnel through a bastion, from an SSH profile.
    Ssh(SshTarget),
}

pub(crate) fn text(value: &Value) -> String {
    match value {
        Value::String(text) => text.trim().to_string(),
        Value::Number(number) => number.to_string(),
        _ => String::new(),
    }
}

impl Route {
    /// From transport settings without SSH profiles at hand (see [`Self::with_profiles`]).
    pub fn from_settings(settings: &Value) -> Result<Self> {
        Self::with_profiles(settings, &Value::Null)
    }
    /// From transport settings: `route` (`{via, host, port, username, password, remoteDns}`,
    /// `via` being `direct`, `http`, `socks5`, or `ssh` with the id of a `profile` that
    /// `profiles` describes), or the older `proxy` (`{protocol, host, port, username,
    /// password, uri, disabled}`) that requests saved before routes still have.
    pub fn with_profiles(settings: &Value, profiles: &Value) -> Result<Self> {
        let route = &settings["route"];
        if route.is_object() {
            let via = text(&route["via"]);
            if via == "ssh" {
                let id = text(&route["profile"]);
                if id.is_empty() {
                    return Err(Error::Validation(
                        "Choose the SSH profile to connect through".into(),
                    ));
                }
                let profile = &profiles[&id];
                if !profile.is_object() {
                    return Err(Error::Validation(
                        "The SSH profile of this connection no longer exists".into(),
                    ));
                }
                return Ok(Self::Ssh(SshTarget::from_profile(&id, profile)?));
            }
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
            Self::Direct | Self::Ssh(_) => None,
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
            Self::Direct | Self::Ssh(_) => None,
            Self::Http { credentials, .. } | Self::Socks5 { credentials, .. } => {
                credentials.as_ref()
            }
        }
    }
    pub fn proxy(&self) -> Option<&Endpoint> {
        match self {
            Self::Direct | Self::Ssh(_) => None,
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

#[cfg(test)]
mod tests;
