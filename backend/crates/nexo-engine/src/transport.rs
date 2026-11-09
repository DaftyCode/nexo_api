//! HTTP transport for requests and scripts.
use crate::{collection::request_url, egress::Policy};
use base64::{Engine as _, engine::general_purpose::STANDARD};
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

/// A `multipart/form-data` body. Text rows are sent as text, with their `contentType` when
/// they have one; file rows send the files chosen for them, with their name and type, and a
/// file row whose file was not chosen fails, as a file cannot be read from its path.
fn multipart(rows: &[Value]) -> Result<(String, Vec<u8>)> {
    let boundary = format!("----nexo{}", uuid::Uuid::new_v4().simple());
    // As browsers do: quotes encoded and line breaks removed from names.
    let escape = |value: &str| value.replace('"', "%22").replace(['\r', '\n'], " ");
    let header = |value: &str| value.replace(['\r', '\n'], " ");
    let mut body = Vec::new();
    for row in rows.iter().filter(|row| row["disabled"] != true) {
        let name = escape(&string(row.get("key")));
        if crate::files::is_file(row) {
            let sources = crate::files::sources(&row["src"]);
            let parts = crate::files::attached(row)?;
            if parts.len() < sources.len() {
                let missing = &sources[parts.len()];
                return Err(Error::Validation(format!(
                    "Choose the file {missing} for the form-data field {}",
                    string(row.get("key"))
                )));
            }
            for part in parts {
                body.extend_from_slice(
                    format!(
                        "--{boundary}\r\nContent-Disposition: form-data; name=\"{name}\"; filename=\"{}\"\r\nContent-Type: {}\r\n\r\n",
                        escape(&part.name),
                        header(&part.content_type)
                    )
                    .as_bytes(),
                );
                body.extend_from_slice(&part.bytes);
                body.extend_from_slice(b"\r\n");
            }
            continue;
        }
        let content_type = row["contentType"]
            .as_str()
            .filter(|value| !value.trim().is_empty())
            .map(|value| format!("Content-Type: {}\r\n", header(value)))
            .unwrap_or_default();
        body.extend_from_slice(
            format!(
                "--{boundary}\r\nContent-Disposition: form-data; name=\"{name}\"\r\n{content_type}\r\n{}\r\n",
                string(row.get("value"))
            )
            .as_bytes(),
        );
    }
    body.extend_from_slice(format!("--{boundary}--\r\n").as_bytes());
    Ok((format!("multipart/form-data; boundary={boundary}"), body))
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
    /// `secrets` are the restricted vault secrets it carries: no hop, redirects included,
    /// takes one to a host it does not allow.
    pub async fn request(
        &self,
        input: &Value,
        secrets: &[crate::secret_hosts::Placement],
    ) -> Result<Value> {
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
        let mut auth = auth_values(&input["auth"]);
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
                    let (content_type, data) = multipart(&rows)?;
                    headers.set("content-type", &content_type);
                    body = Some(data);
                }
                // Postman's "binary": the bytes of one file, as chosen.
                Some("file") => {
                    let file = &body_input["file"];
                    let src = file["src"].as_str().unwrap_or_default();
                    match crate::files::attached(file)?.into_iter().next() {
                        Some(part) => {
                            if !headers.has("content-type") {
                                headers.set("content-type", &part.content_type);
                            }
                            body = Some(part.bytes);
                        }
                        None if !src.trim().is_empty() => {
                            return Err(Error::Validation(format!(
                                "Choose the file {src} to send as the body"
                            )));
                        }
                        None => {}
                    }
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
        // Signed once the request is built: Digest `auth-int` and the signature types read
        // the final method, URL, headers and body.
        let had_body = body.is_some();
        let mut signed_body = body.take().unwrap_or_default();
        crate::auth::sign(
            &auth,
            &mut crate::auth::Outgoing {
                method: &method,
                url: &mut url,
                headers: &mut headers,
                body: &mut signed_body,
                credential_headers: &mut credential_headers,
            },
        )?;
        // OAuth 1.0 may have added its parameters to a form body.
        if had_body || !signed_body.is_empty() {
            body = Some(signed_body.clone());
        }
        let origin = url.origin();
        // Challenges answered: Digest answers one, NTLM two (negotiate, then authenticate).
        let mut challenges_answered = 0;
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
            crate::secret_hosts::check_hop(
                secrets,
                &crate::secret_hosts::Hop {
                    host: &host,
                    same_origin: url.origin() == origin,
                    body: body.is_some(),
                    credential_headers: &credential_headers,
                    trust_redirect_credentials: self.options.trust_redirect_credentials,
                },
            )?;
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
            if (status == 401 || status == 403) && challenges_answered < 2 && url.origin() == origin
            {
                let challenges: Vec<String> = response
                    .headers()
                    .get_all(reqwest::header::WWW_AUTHENTICATE)
                    .iter()
                    .filter_map(|v| v.to_str().ok())
                    .map(String::from)
                    .collect();
                let answered = crate::auth::answer_challenge(
                    &mut auth,
                    challenges_answered,
                    status,
                    &challenges,
                    &mut crate::auth::Outgoing {
                        method: &method,
                        url: &mut url,
                        headers: &mut headers,
                        body: &mut signed_body,
                        credential_headers: &mut credential_headers,
                    },
                )?;
                if answered {
                    challenges_answered += 1;
                    // Read the body to the end so the connection is reused: NTLM authenticates
                    // the connection, not each request.
                    let _ = response.bytes().await;
                    continue;
                }
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
    fn multipart_sends_file_bytes_as_chosen() {
        let bytes = [0x89u8, 0x50, 0x00, 0xff, 0xfe, b'\r', b'\n'];
        let mut request = json!({"body": {"mode": "formdata", "formdata": [
            {"key": "note", "value": "hi", "contentType": "text/plain"},
            {"key": "avatar\"", "type": "file", "src": "my \"photo\".png"},
            {"key": "off", "type": "file", "src": "x.bin", "disabled": true},
            {"key": "empty", "type": "file"},
        ]}});
        crate::files::Files::from_payload(&json!({"files": [
            {"src": "my \"photo\".png", "content": STANDARD.encode(bytes), "contentType": "image/png"}
        ]}))
        .unwrap()
        .attach(&mut request);
        let (content_type, body) =
            multipart(request["body"]["formdata"].as_array().unwrap()).unwrap();
        let boundary = content_type.split("boundary=").nth(1).unwrap();
        let mut expected = format!(
            "--{boundary}\r\nContent-Disposition: form-data; name=\"note\"\r\nContent-Type: text/plain\r\n\r\nhi\r\n\
             --{boundary}\r\nContent-Disposition: form-data; name=\"avatar%22\"; filename=\"my %22photo%22.png\"\r\nContent-Type: image/png\r\n\r\n"
        )
        .into_bytes();
        expected.extend_from_slice(&bytes);
        expected.extend_from_slice(format!("\r\n--{boundary}--\r\n").as_bytes());
        assert_eq!(body, expected);

        let missing = json!([{"key": "avatar", "type": "file", "src": "photo.png"}]);
        let error = multipart(missing.as_array().unwrap()).unwrap_err();
        assert_eq!(
            error.to_string(),
            "Choose the file photo.png for the form-data field avatar"
        );
    }
}
