//! HTTP transport for requests and scripts.
use crate::{collection::request_url, egress::Policy};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use cookie_store::{CookieStore, RawCookie};
use md5::Md5;
use nexo_domain::{Error, Result};
use reqwest::{Method, header::HeaderName, header::HeaderValue};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
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
}

pub(crate) fn auth_values(auth: &Value) -> serde_json::Map<String, Value> {
    let mut values = auth.as_object().cloned().unwrap_or_default();
    let kind = auth["type"].as_str().unwrap_or("");
    match &auth[kind] {
        Value::Array(rows) => {
            for row in rows {
                if let Some(key) = row["key"].as_str() {
                    values.insert(key.to_string(), row["value"].clone());
                }
            }
        }
        Value::Object(object) => values.extend(object.clone()),
        _ => {}
    }
    values
}
fn string(value: Option<&Value>) -> String {
    match value {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Null) | None => String::new(),
        Some(other) => other.to_string(),
    }
}

fn digest_header(
    challenge: &str,
    auth: &serde_json::Map<String, Value>,
    url: &Url,
    method: &str,
) -> Result<String> {
    let mut parts = std::collections::HashMap::new();
    let mut rest = challenge
        .trim_start_matches(|c: char| c.is_alphabetic())
        .trim();
    while !rest.is_empty() {
        let Some(eq) = rest.find('=') else { break };
        let key = rest[..eq].trim().trim_start_matches(',').trim().to_string();
        rest = rest[eq + 1..].trim_start();
        let value;
        if let Some(stripped) = rest.strip_prefix('"') {
            let end = stripped.find('"').unwrap_or(stripped.len());
            value = stripped[..end].to_string();
            rest = stripped.get(end + 1..).unwrap_or("");
        } else {
            let end = rest.find(',').unwrap_or(rest.len());
            value = rest[..end].trim().to_string();
            rest = &rest[end..];
        }
        parts.insert(key.to_lowercase(), value);
        rest = rest.trim_start_matches([',', ' ']);
    }
    let algorithm = parts
        .get("algorithm")
        .cloned()
        .unwrap_or_else(|| "MD5".into())
        .to_uppercase();
    let hash = |value: &str| -> String {
        if algorithm.starts_with("SHA-256") {
            hex::encode(Sha256::digest(value.as_bytes()))
        } else {
            hex::encode(Md5::digest(value.as_bytes()))
        }
    };
    if !["MD5", "MD5-SESS", "SHA-256", "SHA-256-SESS"].contains(&algorithm.as_str()) {
        return Err(Error::Validation("Unsupported digest algorithm".into()));
    }
    let realm = parts.get("realm").cloned().unwrap_or_default();
    let nonce = parts.get("nonce").cloned().unwrap_or_default();
    let uri = match url.query() {
        Some(query) => format!("{}?{query}", url.path()),
        None => url.path().to_string(),
    };
    let cnonce = hex::encode(crate::vault::rand_bytes::<12>());
    let username = string(auth.get("username"));
    let mut ha1 = hash(&format!(
        "{username}:{realm}:{}",
        string(auth.get("password"))
    ));
    if algorithm.ends_with("-SESS") {
        ha1 = hash(&format!("{ha1}:{nonce}:{cnonce}"));
    }
    let qop = parts
        .get("qop")
        .is_some_and(|q| q.split(',').any(|item| item.trim() == "auth"));
    let ha2 = hash(&format!("{method}:{uri}"));
    let response = if qop {
        hash(&format!("{ha1}:{nonce}:00000001:{cnonce}:auth:{ha2}"))
    } else {
        hash(&format!("{ha1}:{nonce}:{ha2}"))
    };
    let quote = |value: &str| value.replace('\\', "\\\\").replace('"', "\\\"");
    let mut header = format!(
        "Digest username=\"{}\", realm=\"{}\", nonce=\"{}\", uri=\"{uri}\", response=\"{response}\", algorithm={algorithm}",
        quote(&username),
        quote(&realm),
        quote(&nonce)
    );
    if qop {
        header.push_str(&format!(", qop=auth, nc=00000001, cnonce=\"{cnonce}\""));
    }
    if let Some(opaque) = parts.get("opaque") {
        header.push_str(&format!(", opaque=\"{}\"", quote(opaque)));
    }
    Ok(header)
}

/// Decodes text with its declared charset; binary payloads are returned as base64.
pub fn decode_body(bytes: &[u8], content_type: &str) -> (String, Option<&'static str>) {
    let kind = content_type
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_lowercase();
    let textual = kind.starts_with("text/")
        || kind.contains("json")
        || kind.contains("xml")
        || kind.contains("javascript")
        || kind.contains("x-www-form-urlencoded")
        || kind.contains("graphql");
    let binary = !textual
        && (kind.starts_with("image/")
            || kind.starts_with("audio/")
            || kind.starts_with("video/")
            || kind.starts_with("font/")
            || [
                "application/octet-stream",
                "application/pdf",
                "application/zip",
                "application/gzip",
            ]
            .contains(&kind.as_str())
            || bytes[..bytes.len().min(4096)].contains(&0));
    if binary {
        return (STANDARD.encode(bytes), Some("base64"));
    }
    let charset = content_type
        .split(';')
        .filter_map(|part| part.trim().strip_prefix("charset="))
        .next()
        .map(|c| c.trim_matches('"').to_lowercase());
    if let Some(charset) = charset.filter(|c| c != "utf-8" && c != "utf8")
        && let Some(encoding) = encoding_rs::Encoding::for_label(charset.as_bytes())
    {
        return (encoding.decode(bytes).0.into_owned(), None);
    }
    (String::from_utf8_lossy(bytes).into_owned(), None)
}

fn multipart(rows: &[Value]) -> (String, Vec<u8>) {
    let boundary = format!("----nexo{}", uuid::Uuid::new_v4().simple());
    let mut body = Vec::new();
    for row in rows.iter().filter(|row| row["disabled"] != true) {
        let escape = |value: &str| value.replace('"', "%22").replace(['\r', '\n'], " ");
        body.extend_from_slice(
            format!(
                "--{boundary}\r\nContent-Disposition: form-data; name=\"{}\"\r\n\r\n{}\r\n",
                escape(&string(row.get("key"))),
                string(row.get("value"))
            )
            .as_bytes(),
        );
    }
    body.extend_from_slice(format!("--{boundary}--\r\n").as_bytes());
    (format!("multipart/form-data; boundary={boundary}"), body)
}

pub struct Transport {
    client: reqwest::Client,
    options: Options,
    jar: CookieJar,
    proxied: Option<String>,
}
impl Transport {
    pub fn new(options: Options, jar: CookieJar) -> Result<Self> {
        let settings = &options.transport;
        let mut builder = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .danger_accept_invalid_certs(!options.strict_ssl)
            .timeout(options.timeout)
            .dns_resolver(Arc::new(GuardedResolver {
                policy: options.egress.clone(),
                loopback_ports: options.loopback_ports.clone(),
            }));
        if let Some(pem) = settings["caPem"].as_str().filter(|p| !p.trim().is_empty()) {
            for certificate in reqwest::Certificate::from_pem_bundle(pem.as_bytes())
                .map_err(|error| Error::Validation(format!("Invalid CA certificate: {error}")))?
            {
                builder = builder.add_root_certificate(certificate);
            }
        }
        if let (Some(cert), Some(key)) = (
            settings["clientTls"]["certPem"].as_str(),
            settings["clientTls"]["keyPem"].as_str(),
        ) {
            let identity = reqwest::Identity::from_pem(format!("{cert}\n{key}").as_bytes())
                .map_err(|error| {
                    Error::Validation(format!("Invalid client certificate: {error}"))
                })?;
            builder = builder.identity(identity);
        }
        let mut proxied = None;
        let proxy = &settings["proxy"];
        if proxy.is_object() && proxy["disabled"] != true {
            let uri = proxy["uri"].as_str().map(String::from).unwrap_or_else(|| {
                format!(
                    "{}://{}:{}",
                    proxy["protocol"].as_str().unwrap_or("http"),
                    proxy["host"].as_str().unwrap_or(""),
                    string(proxy.get("port"))
                )
            });
            let mut configured = reqwest::Proxy::all(&uri)
                .map_err(|error| Error::Validation(format!("Invalid proxy: {error}")))?;
            if let Some(user) = proxy["username"].as_str() {
                configured = configured.basic_auth(user, proxy["password"].as_str().unwrap_or(""));
            }
            builder = builder.proxy(configured);
            proxied = Some(uri);
        } else {
            builder = builder.no_proxy();
        }
        Ok(Self {
            client: builder
                .build()
                .map_err(|error| Error::Infrastructure(error.to_string()))?,
            options,
            jar,
            proxied,
        })
    }

    /// Sends a collection-format request (`url`, `method`, `header`, `auth`, `body`).
    pub async fn request(&self, input: &Value) -> Result<Value> {
        let started = Instant::now();
        let mut url = parse_url(&request_url(&input["url"]))?;
        let mut method = crate::collection::http_method(input["method"].as_str().unwrap_or("GET"))?;
        let mut headers = HeaderList::default();
        let header_rows: Vec<(String, String)> = match &input["header"] {
            Value::Array(rows) => rows
                .iter()
                .filter(|h| h["disabled"] != true && h["enabled"] != false)
                .filter_map(|h| {
                    h["key"]
                        .as_str()
                        .filter(|k| !k.is_empty())
                        .map(|k| (k.to_string(), string(h.get("value"))))
                })
                .collect(),
            Value::Object(map) => map
                .iter()
                .map(|(k, v)| (k.clone(), string(Some(v))))
                .collect(),
            _ => vec![],
        };
        for (key, value) in header_rows {
            headers.append(&key, &value);
        }
        let mut credential_headers: Vec<String> = SENSITIVE.iter().map(|s| s.to_string()).collect();
        let auth = auth_values(&input["auth"]);
        let kind = auth
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        match kind.as_str() {
            "basic" => headers.set(
                "authorization",
                &format!(
                    "Basic {}",
                    STANDARD.encode(format!(
                        "{}:{}",
                        string(auth.get("username")),
                        string(auth.get("password"))
                    ))
                ),
            ),
            "bearer" | "oauth2" => {
                let token = auth.get("token").or_else(|| auth.get("accessToken"));
                headers.set("authorization", &format!("Bearer {}", string(token)));
            }
            "apikey" => {
                let key = string(auth.get("key"));
                if key.trim().is_empty() {
                    return Err(Error::Validation(
                        "API key authentication needs a key name".into(),
                    ));
                }
                if auth.get("in").and_then(Value::as_str) == Some("query") {
                    url.query_pairs_mut()
                        .append_pair(&key, &string(auth.get("value")));
                } else {
                    headers.set(&key, &string(auth.get("value")));
                    credential_headers.push(key.to_lowercase());
                }
            }
            "" | "noauth" | "inherit" | "digest" => {}
            other => {
                return Err(Error::Validation(format!(
                    "Unsupported authentication helper: {other}"
                )));
            }
        }
        let mut warnings = Vec::new();
        let mut body: Option<Vec<u8>> = None;
        let body_input = &input["body"];
        let has_body = match body_input {
            Value::Object(b) => {
                b.get("mode").and_then(Value::as_str) != Some("raw")
                    || !string(b.get("raw")).is_empty()
            }
            Value::String(text) => !text.is_empty(),
            _ => false,
        };
        if method == "GET" || method == "HEAD" {
            if has_body {
                warnings.push(format!("{method} requests are sent without a body"));
            }
        } else {
            match body_input["mode"].as_str() {
                Some("urlencoded") => {
                    let mut serializer = url::form_urlencoded::Serializer::new(String::new());
                    for row in body_input["urlencoded"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .filter(|r| r["disabled"] != true)
                    {
                        serializer.append_pair(&string(row.get("key")), &string(row.get("value")));
                    }
                    body = Some(serializer.finish().into_bytes());
                    if !headers.has("content-type") {
                        headers.set("content-type", "application/x-www-form-urlencoded");
                    }
                }
                Some("formdata") => {
                    let rows = body_input["formdata"]
                        .as_array()
                        .cloned()
                        .unwrap_or_default();
                    if rows
                        .iter()
                        .any(|row| row["type"] == "file" && row["disabled"] != true)
                    {
                        return Err(Error::Validation(
                            "Supply file contents explicitly; filesystem paths are unavailable"
                                .into(),
                        ));
                    }
                    let (content_type, data) = multipart(&rows);
                    headers.set("content-type", &content_type);
                    body = Some(data);
                }
                Some("graphql") => {
                    let variables_text =
                        body_input["graphql"]["variables"].as_str().unwrap_or("{}");
                    let variables: Value =
                        serde_json::from_str(if variables_text.trim().is_empty() {
                            "{}"
                        } else {
                            variables_text
                        })
                        .map_err(|error| {
                            Error::Validation(format!(
                                "GraphQL variables must be valid JSON: {error}"
                            ))
                        })?;
                    body = Some(json!({"query": body_input["graphql"]["query"].as_str().unwrap_or(""), "variables": variables}).to_string().into_bytes());
                    if !headers.has("content-type") {
                        headers.set("content-type", "application/json");
                    }
                }
                _ => {
                    let raw = match body_input {
                        Value::String(text) => text.clone(),
                        _ => string(body_input.get("raw")),
                    };
                    if !raw.is_empty() {
                        if body_input["options"]["raw"]["language"] == "json"
                            && !headers.has("content-type")
                        {
                            headers.set("content-type", "application/json");
                        }
                        body = Some(raw.into_bytes());
                    }
                }
            }
        }
        let origin = url.origin();
        let mut digest_sent = false;
        let mut redirects = 0;
        let response = loop {
            let host = url.host_str().unwrap_or("").to_string();
            let port = url.port_or_known_default().unwrap_or(80);
            match &self.proxied {
                Some(proxy) => {
                    let proxy_url = parse_url(proxy)?;
                    self.options
                        .egress
                        .resolve(
                            proxy_url.host_str().unwrap_or(""),
                            proxy_url.port_or_known_default().unwrap_or(80),
                            &self.options.loopback_ports,
                        )
                        .await?;
                }
                None => {
                    self.options
                        .egress
                        .resolve(&host, port, &self.options.loopback_ports)
                        .await?;
                }
            }
            let mut hop = headers.clone();
            if url.origin() != origin && !self.options.trust_redirect_credentials {
                for name in &credential_headers {
                    hop.delete(name);
                }
            }
            if !hop.has("cookie") {
                let cookie = {
                    let jar = self.jar.lock().unwrap_or_else(|e| e.into_inner());
                    jar.get_request_values(&url)
                        .map(|(name, value)| format!("{name}={value}"))
                        .collect::<Vec<_>>()
                        .join("; ")
                };
                if !cookie.is_empty() {
                    hop.set("cookie", &cookie);
                }
            }
            let mut request = self.client.request(
                Method::from_bytes(method.as_bytes())
                    .map_err(|_| Error::Validation("Invalid HTTP method".into()))?,
                url.clone(),
            );
            for (name, value) in &hop.0 {
                let name = HeaderName::from_bytes(name.as_bytes())
                    .map_err(|_| Error::Validation(format!("Invalid header name: {name}")))?;
                let value = HeaderValue::from_str(value)
                    .map_err(|_| Error::Validation(format!("Invalid value for header {name}")))?;
                request = request.header(name, value);
            }
            if let Some(data) = &body {
                request = request.body(data.clone());
            }
            let response = request.send().await.map_err(request_error)?;
            {
                let mut jar = self.jar.lock().unwrap_or_else(|e| e.into_inner());
                let cookies = response
                    .headers()
                    .get_all(reqwest::header::SET_COOKIE)
                    .iter()
                    .filter_map(|v| v.to_str().ok())
                    .filter_map(|v| RawCookie::parse(v.to_string()).ok());
                jar.store_response_cookies(cookies, &url);
            }
            let status = response.status().as_u16();
            if status == 401
                && kind == "digest"
                && !digest_sent
                && url.origin() == origin
                && let Some(challenge) = response
                    .headers()
                    .get(reqwest::header::WWW_AUTHENTICATE)
                    .and_then(|v| v.to_str().ok())
                    .filter(|c| c.to_lowercase().starts_with("digest "))
            {
                headers.set(
                    "authorization",
                    &digest_header(challenge, &auth, &url, &method)?,
                );
                digest_sent = true;
                continue;
            }
            let location = response
                .headers()
                .get(reqwest::header::LOCATION)
                .and_then(|v| v.to_str().ok())
                .map(String::from);
            if ![301, 302, 303, 307, 308].contains(&status)
                || location.is_none()
                || !self.options.follow_redirects
            {
                break response;
            }
            redirects += 1;
            if redirects > 20 {
                return Err(Error::Validation("Maximum redirect count exceeded".into()));
            }
            url = url
                .join(&location.unwrap_or_default())
                .map_err(|_| Error::Validation("Invalid redirect location".into()))?;
            if !["http", "https"].contains(&url.scheme()) {
                return Err(Error::Validation(format!(
                    "Unsupported URL protocol {}:",
                    url.scheme()
                )));
            }
            if (status == 303 && method != "HEAD")
                || ([301, 302].contains(&status) && method == "POST")
            {
                method = "GET".into();
                body = None;
                headers.delete("content-type");
                headers.delete("content-length");
            }
        };
        let status = response.status();
        let response_headers: Vec<Value> = response
            .headers()
            .iter()
            .map(|(k, v)| json!({"key": k.as_str(), "value": v.to_str().unwrap_or_default()}))
            .collect();
        let content_type = response
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .unwrap_or("")
            .to_string();
        let declared = response.content_length();
        let mut response = response;
        let mut bytes = Vec::new();
        let mut size = 0usize;
        let mut truncated = false;
        while let Some(chunk) = response.chunk().await.map_err(request_error)? {
            size += chunk.len();
            if size > MAX_BODY {
                truncated = true;
                break;
            }
            bytes.extend_from_slice(&chunk);
        }
        let (text, encoding) = decode_body(&bytes, &content_type);
        let cookies: Vec<Value> = {
            let jar = self.jar.lock().unwrap_or_else(|e| e.into_inner());
            jar.matches(&url)
                .into_iter()
                .map(|cookie| json!({"key": cookie.name(), "value": cookie.value(), "domain": cookie.domain(), "path": cookie.path()}))
                .collect()
        };
        let mut result = json!({
            "url": url.as_str(),
            "method": method,
            "status": status.as_u16(),
            "statusText": status.canonical_reason().unwrap_or(""),
            "headers": response_headers,
            "body": text,
            "size": if truncated { declared.map(|d| d as usize).unwrap_or(size).max(size) } else { size },
            "time": started.elapsed().as_millis() as u64,
            "cookies": cookies,
        });
        if let Some(encoding) = encoding {
            result["bodyEncoding"] = json!(encoding);
        }
        if truncated {
            result["truncated"] = json!(true);
        }
        if !warnings.is_empty() {
            result["warnings"] = json!(warnings);
        }
        Ok(result)
    }
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
mod tests {
    use super::*;
    #[test]
    fn decodes_binary_and_charsets() {
        let (body, encoding) = decode_body(&[0x89, 0x50, 0, 1], "image/png");
        assert_eq!(encoding, Some("base64"));
        assert_eq!(STANDARD.decode(body).unwrap(), [0x89, 0x50, 0, 1]);
        let (text, _) = decode_body(
            &[0x45, 0x73, 0x70, 0x61, 0xf1, 0x61],
            "text/plain; charset=iso-8859-1",
        );
        assert_eq!(text, "España");
        assert_eq!(decode_body(b"{\"a\":1}", "application/json").0, "{\"a\":1}");
    }
    #[test]
    fn computes_digest_headers() {
        let auth = serde_json::Map::from_iter([
            ("username".to_string(), json!("Mufasa")),
            ("password".to_string(), json!("Circle Of Life")),
        ]);
        let url = Url::parse("http://x.test/dir/index.html").unwrap();
        let header = digest_header(
            "Digest realm=\"testrealm@host.com\", nonce=\"dcd98b7102dd2f0e8b11d0f600bfb0c093\", opaque=\"5ccc069c403ebaf9f0171e9517f40e41\"",
            &auth,
            &url,
            "GET",
        )
        .unwrap();
        // MD5(HA1:nonce:HA2) as defined by RFC 2069 for challenges without qop.
        assert!(
            header.contains("response=\"670fd8c2df070c60b045671b8b24ff02\""),
            "{header}"
        );
    }
}
