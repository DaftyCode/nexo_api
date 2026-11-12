//! HTTP transport for requests and scripts.

mod body;
mod client;
mod send;

use crate::{collection::request_url, egress::Policy};
use base64::{Engine as _, engine::general_purpose::STANDARD};
pub use body::decode_body;
#[cfg(test)]
use body::multipart;
use body::{request_body, request_headers};
use cookie_store::{CookieStore, RawCookie};
use nexo_domain::{Error, Result};
use reqwest::{Method, header::HeaderName, header::HeaderValue};
use serde_json::{Value, json};
use std::{
    net::SocketAddr,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use url::Url;

pub const MAX_BODY: usize = 8 * 1024 * 1024;
/// Headers that carry credentials and must not follow a redirect to another origin.
const SENSITIVE: [&str; 8] = [
    "authorization",
    "proxy-authorization",
    "cookie",
    "x-api-key",
    "api-key",
    "x-auth-token",
    "private-token",
    "x-access-token",
];

pub type CookieJar = Arc<Mutex<CookieStore>>;

/// Per-execution transport settings.
#[derive(Clone, Debug)]
pub struct Options {
    pub strict_ssl: bool,
    pub follow_redirects: bool,
    pub timeout: Duration,
    pub trust_redirect_credentials: bool,
    /// `{proxy, caPem, clientTls}` from the request's transport settings.
    pub transport: Value,
    pub egress: Policy,
    pub loopback_ports: Vec<u16>,
}
impl Options {
    pub fn from_payload(
        payload: &Value,
        transport: &Value,
        egress: Policy,
        loopback_ports: Vec<u16>,
    ) -> Self {
        Self {
            strict_ssl: payload["strictSSL"] != false,
            follow_redirects: payload["followRedirects"] != false,
            timeout: Duration::from_millis(
                payload["timeout"]
                    .as_u64()
                    .unwrap_or(30_000)
                    .clamp(1, 120_000),
            ),
            trust_redirect_credentials: payload["trustRedirectCredentials"] == true,
            transport: transport.clone(),
            egress,
            loopback_ports,
        }
    }
}

/// Parses the `nexoTransport`/`transport` setting, which is JSON text or an object.
pub fn transport_settings(value: &Value) -> Result<Value> {
    match value {
        Value::String(text) if text.trim().is_empty() => Ok(json!({})),
        Value::String(text) => serde_json::from_str(text).map_err(|error| {
            Error::Validation(format!("Transport settings must be valid JSON: {error}"))
        }),
        Value::Object(_) => Ok(value.clone()),
        _ => Ok(json!({})),
    }
}

/// Resolver that applies the egress policy to every DNS answer, so a hostname cannot
/// switch to a blocked address between the check and the connection.
struct GuardedResolver {
    policy: Policy,
    loopback_ports: Vec<u16>,
}
impl reqwest::dns::Resolve for GuardedResolver {
    fn resolve(&self, name: reqwest::dns::Name) -> reqwest::dns::Resolving {
        let policy = self.policy.clone();
        let ports = self.loopback_ports.clone();
        let host = name.as_str().to_string();
        Box::pin(async move {
            let addresses = policy.resolve(&host, 0, &ports).await.map_err(
                |error| -> Box<dyn std::error::Error + Send + Sync> { error.to_string().into() },
            )?;
            Ok(Box::new(addresses.into_iter()) as Box<dyn Iterator<Item = SocketAddr> + Send>)
        })
    }
}

/// Ordered header list that keeps repeated names.
#[derive(Clone, Default, Debug)]
pub struct HeaderList(Vec<(String, String)>);
impl HeaderList {
    pub fn append(&mut self, name: &str, value: &str) {
        self.0.push((name.to_string(), value.to_string()));
    }
    pub fn set(&mut self, name: &str, value: &str) {
        self.delete(name);
        self.append(name, value);
    }
    pub fn has(&self, name: &str) -> bool {
        self.0.iter().any(|(key, _)| key.eq_ignore_ascii_case(name))
    }
    pub fn delete(&mut self, name: &str) {
        self.0.retain(|(key, _)| !key.eq_ignore_ascii_case(name));
    }
    /// Every header, in order.
    pub fn iter(&self) -> impl Iterator<Item = (&str, &str)> {
        self.0
            .iter()
            .map(|(name, value)| (name.as_str(), value.as_str()))
    }
    /// Values of every header called `name`, in order.
    pub fn get(&self, name: &str) -> Vec<&str> {
        self.0
            .iter()
            .filter(|(key, _)| key.eq_ignore_ascii_case(name))
            .map(|(_, value)| value.as_str())
            .collect()
    }
}

pub(crate) use crate::auth::values as auth_values;
fn string(value: Option<&Value>) -> String {
    match value {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Null) | None => String::new(),
        Some(other) => other.to_string(),
    }
}

pub struct Transport {
    client: reqwest::Client,
    options: Options,
    jar: CookieJar,
    proxied: Option<String>,
}

pub fn parse_url(text: &str) -> Result<Url> {
    let url =
        Url::parse(text).map_err(|_| Error::Validation("A complete URL is required".into()))?;
    if !["http", "https"].contains(&url.scheme()) {
        return Err(Error::Validation(format!(
            "Unsupported URL protocol {}:",
            url.scheme()
        )));
    }
    Ok(url)
}
/// Client for engine calls that are not user requests (OAuth tokens, MCP): no redirects,
/// no proxy and the egress policy applied to every resolved address.
pub fn guarded_client(
    egress: &Policy,
    loopback_ports: Vec<u16>,
    timeout: Duration,
) -> Result<reqwest::Client> {
    reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .no_proxy()
        .timeout(timeout)
        .dns_resolver(Arc::new(GuardedResolver {
            policy: egress.clone(),
            loopback_ports,
        }))
        .build()
        .map_err(|error| Error::Infrastructure(error.to_string()))
}
/// Reads a response body as text, failing once it exceeds `limit` bytes.
pub async fn read_limited(mut response: reqwest::Response, limit: usize) -> Result<String> {
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(request_error)? {
        bytes.extend_from_slice(&chunk);
        if bytes.len() > limit {
            return Err(Error::Validation(format!(
                "Response exceeds {} MB",
                limit / 1024 / 1024
            )));
        }
    }
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}
pub(crate) fn request_error(error: reqwest::Error) -> Error {
    let mut message = error.to_string();
    let mut source = std::error::Error::source(&error);
    while let Some(cause) = source {
        message = format!("{message}: {cause}");
        source = cause.source();
    }
    if error.is_timeout() {
        message = "The request timed out".into();
    }
    Error::Validation(message)
}

#[cfg(test)]
mod tests;
