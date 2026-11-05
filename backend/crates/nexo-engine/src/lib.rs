//! Request execution engine: HTTP, scripts, protocols, mocks, datasets and the secret vault.
//!
//! It runs inside the Nexo process. Every network destination passes the egress policy and
//! scripts run in a QuickJS sandbox without host access.
use async_trait::async_trait;
use nexo_application::{
    operations::Operation,
    ports::{ExecutionGateway, SecretVault},
};
use nexo_domain::{Error, Result};
use serde_json::{Map, Value, json};
use std::{path::Path, sync::Arc, time::Duration};

pub mod auth;
pub mod collection;
pub mod datasets;
pub mod egress;
pub mod grpc;
pub mod interchange;
pub mod mocks;
pub mod mqtt;
pub mod oauth2;
pub mod oauth2_flow;
pub mod oauth2_tokens;
pub mod performance;
pub mod realtime;
pub mod runner;
pub mod scripts;
pub mod tls;
pub mod transport;
pub mod vault;

use crate::{
    datasets::Datasets,
    egress::Policy,
    mocks::Mocks,
    performance::Performance,
    realtime::Realtime,
    runner::{Context, Jars, Runs, cookie_scope},
    transport::{guarded_client, parse_url, read_limited},
    vault::{Vault, load_master_key},
};

fn invalid(message: impl Into<String>) -> Error {
    Error::Validation(message.into())
}
/// Every OAuth 2.0 authorization in a request or run payload.
fn oauth2_auths(value: &Value, found: &mut Vec<Value>) {
    match value {
        Value::Object(map) => {
            if map.get("type").and_then(Value::as_str) == Some("oauth2")
                && map.contains_key("oauth2")
            {
                found.push(value.clone());
            }
            map.values().for_each(|item| oauth2_auths(item, found));
        }
        Value::Array(items) => items.iter().for_each(|item| oauth2_auths(item, found)),
        _ => {}
    }
}
fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as u64)
        .unwrap_or_default()
}
fn id(payload: &Value) -> &str {
    payload["id"].as_str().unwrap_or_default()
}

pub struct Engine {
    egress: Policy,
    mocks: Arc<Mocks>,
    runs: Arc<Runs>,
    realtime: Realtime,
    datasets: Arc<Datasets>,
    performance: Performance,
    vault: Vault,
    oauth2_flows: oauth2_flow::Flows,
}
impl Engine {
    /// Opens the engine over `<data>`: `vault/`, `datasets/` and `cookies/`.
    pub fn new(data: &Path, master_key: Option<String>) -> Result<Self> {
        Self::with_policy(data, master_key, Policy::from_env())
    }
    pub fn with_policy(data: &Path, master_key: Option<String>, egress: Policy) -> Result<Self> {
        let key = load_master_key(data, master_key)?;
        let mocks = Arc::new(Mocks::default());
        let ports = {
            let mocks = mocks.clone();
            Arc::new(move || mocks.ports()) as Arc<dyn Fn() -> Vec<u16> + Send + Sync>
        };
        let runs = Arc::new(Runs::new(
            Arc::new(Jars::new(data.join("cookies"))),
            Context {
                egress: egress.clone(),
                loopback_ports: ports.clone(),
            },
        ));
        Ok(Self {
            realtime: Realtime::new(egress.clone(), ports),
            datasets: Arc::new(Datasets::new(data.join("datasets"))),
            performance: Performance::new(runs.clone()),
            vault: Vault::new(data.join("vault"), key, "local"),
            oauth2_flows: oauth2_flow::Flows::default(),
            egress,
            mocks,
            runs,
        })
    }
    /// Stops connections, mocks and executions.
    pub fn close(&self) {
        self.oauth2_flows.close();
        self.realtime.close();
        self.mocks.close();
        self.performance.close();
        self.runs.cancel_all();
    }
    async fn dataset_query(&self, payload: Value) -> Result<Value> {
        let datasets = self.datasets.clone();
        tokio::task::spawn_blocking(move || datasets.query(&payload))
            .await
            .map_err(|error| Error::Infrastructure(error.to_string()))?
    }
    /// Checks the destination, including IP literals that bypass DNS, and builds a client.
    async fn client_for(&self, url: &url::Url) -> Result<reqwest::Client> {
        let ports = self.mocks.ports();
        let host = url.host_str().unwrap_or_default();
        self.egress
            .resolve(host, url.port_or_known_default().unwrap_or(80), &ports)
            .await?;
        guarded_client(&self.egress, ports, Duration::from_secs(30))
    }
    async fn mcp(&self, payload: &Value) -> Result<Value> {
        let url = parse_url(payload["url"].as_str().unwrap_or_default())?;
        let client = self.client_for(&url).await?;
        let mut request = client
            .post(url)
            .header("content-type", "application/json")
            .header("accept", "application/json, text/event-stream");
        if let Some(session) = payload["sessionId"].as_str().filter(|s| !s.is_empty()) {
            request = request.header("mcp-session-id", session);
        }
        for (key, value) in header_pairs(&payload["headers"]) {
            request = request.header(key, value);
        }
        let body = json!({
            "jsonrpc": "2.0",
            "id": uuid::Uuid::new_v4().to_string(),
            "method": payload["method"].as_str().unwrap_or("tools/list"),
            "params": if payload["params"].is_null() { json!({}) } else { payload["params"].clone() },
        });
        let response = request
            .body(body.to_string())
            .send()
            .await
            .map_err(transport::request_error)?;
        let status = response.status().as_u16();
        let session = response
            .headers()
            .get("mcp-session-id")
            .and_then(|v| v.to_str().ok())
            .map(String::from);
        let text = read_limited(response, 4 * 1024 * 1024).await?;
        let result = serde_json::from_str::<Value>(&text).unwrap_or_else(|_| {
            Value::Array(
                text.lines()
                    .filter_map(|line| line.strip_prefix("data:"))
                    .map(|data| {
                        serde_json::from_str(data)
                            .unwrap_or_else(|_| Value::String(data.to_string()))
                    })
                    .collect(),
            )
        });
        Ok(json!({"status": status, "sessionId": session, "result": result}))
    }
    /// "Get New Access Token" and token refresh for an OAuth 2.0 authorization. Its settings
    /// are resolved like the request's, so `{{variables}}` and vault secrets apply.
    /// The token is kept in the vault; the answer describes it without its values.
    async fn oauth2_token(&self, payload: &Value) -> Result<Value> {
        let auth = runner::resolved_auth(payload)?;
        if let Some(id) = payload["tokenId"].as_str().filter(|t| !t.is_empty()) {
            let details = oauth2_tokens::details(&self.vault, id).await?;
            let refresh = details["refreshToken"]
                .as_str()
                .filter(|t| !t.is_empty())
                .ok_or_else(|| invalid("This token has no refresh token"))?;
            let request = oauth2::token_request(&auth, oauth2::Exchange::Refresh(refresh))?;
            let token = self.post_token(request).await?;
            return oauth2_tokens::replace(&self.vault, id, &token).await;
        }
        let token = self
            .post_token(oauth2::token_request(&auth, oauth2::Exchange::New)?)
            .await?;
        oauth2_tokens::store(&self.vault, &auth::text(auth.get("tokenName")), &token).await
    }
    /// "Manage Tokens": `list` (without values), `details` (with them) and `delete`.
    async fn oauth2_tokens(&self, payload: &Value) -> Result<Value> {
        let id = payload["id"].as_str().unwrap_or_default();
        match payload["action"].as_str().unwrap_or("list") {
            "list" => Ok(json!({"tokens": oauth2_tokens::list(&self.vault).await?})),
            "details" => oauth2_tokens::details(&self.vault, id).await,
            "delete" => {
                oauth2_tokens::delete(&self.vault, id).await?;
                Ok(json!({"deleted": true}))
            }
            other => Err(invalid(format!("Unknown token action: {other}"))),
        }
    }
    /// Before a request or a run: renews the OAuth 2.0 tokens it uses that expire within a
    /// minute (Postman's "Auto-refresh Token", on unless turned off; failures keep the old
    /// token, as in Postman) and provides `{{$oauth2.<name>.access_token}}` (Bruno).
    async fn prepare_oauth2(&self, mut payload: Value) -> Value {
        let text = payload.to_string();
        if text.contains("\"oauth2TokenId\"") {
            let mut auths = Vec::new();
            oauth2_auths(&payload, &mut auths);
            for auth in auths {
                self.refresh_expiring(&mut payload, auth).await;
            }
        }
        if text.contains("$oauth2.")
            && let Ok(variables) = oauth2_tokens::variables(&self.vault).await
        {
            payload["resolvedOAuth2"] = Value::Object(variables);
        }
        payload
    }
    async fn refresh_expiring(&self, payload: &mut Value, stored: Value) {
        let values = auth::values(&stored);
        let id = auth::text(values.get("oauth2TokenId"));
        let disabled = matches!(values.get("autoRefreshToken"), Some(Value::Bool(false)))
            || auth::text(values.get("autoRefreshToken")) == "false";
        if id.is_empty() || disabled {
            return;
        }
        let Ok(details) = oauth2_tokens::details(&self.vault, &id).await else {
            return;
        };
        let expiring = details["expiresAt"]
            .as_u64()
            .is_some_and(|at| at <= now_ms() + 60_000);
        let Some(refresh) = details["refreshToken"].as_str().filter(|t| !t.is_empty()) else {
            return;
        };
        if !expiring {
            return;
        }
        // The token settings, resolved with the variables of this request or run.
        let context = if payload["collection"].is_object() {
            json!({"ancestors": [{"variable": payload["collection"]["variable"]}]})
        } else {
            payload["context"].clone()
        };
        let probe = json!({
            "request": {"name": "OAuth 2.0", "request": {"method": "GET", "url": "https://oauth2.invalid/", "auth": stored}},
            "variables": payload["variables"],
            "globals": payload["globals"],
            "context": context,
            "resolvedSecrets": payload["resolvedSecrets"],
        });
        let Ok(settings) = runner::resolved_auth(&probe) else {
            return;
        };
        let Ok(request) = oauth2::token_request(&settings, oauth2::Exchange::Refresh(refresh))
        else {
            return;
        };
        let Ok(token) = self.post_token(request).await else {
            return;
        };
        if oauth2_tokens::replace(&self.vault, &id, &token)
            .await
            .is_err()
        {
            return;
        }
        // The vault references were resolved before the refresh: use the new values.
        if let Some(secrets) = payload["resolvedSecrets"].as_object_mut() {
            let access = token["accessToken"].as_str().or(token["idToken"].as_str());
            for (key, value) in [
                (format!("nexo-oauth2:{id}"), access),
                (format!("nexo-oauth2-id:{id}"), token["idToken"].as_str()),
            ] {
                if let Some(value) = value.filter(|_| secrets.contains_key(&key)) {
                    secrets.insert(key, json!(value));
                }
            }
        }
    }
    /// Browser sign-ins: `start` (default), then `status` until done, `complete` with the
    /// address the browser returned to (manual mode) or `cancel`.
    async fn oauth2_authorize(&self, payload: &Value) -> Result<Value> {
        let session = payload["session"].as_str().unwrap_or_default();
        match payload["action"].as_str().unwrap_or("start") {
            "start" => {
                let auth = runner::resolved_auth(payload)?;
                let relay = std::env::var("NEXO_OAUTH_RELAY_URL")
                    .unwrap_or_else(|_| oauth2::RELAY_URL.to_string());
                let started = self.oauth2_flows.start(auth, &relay).await?;
                let opened = payload["openBrowser"] != false
                    && oauth2_flow::open_browser(started.authorization_url.as_str());
                Ok(json!({
                    "session": started.id,
                    "authorizationUrl": started.authorization_url.as_str(),
                    "mode": started.mode,
                    "redirectUri": started.redirect_uri,
                    "opened": opened,
                }))
            }
            "complete" => {
                let flow = self.oauth2_flows.get(session)?;
                let pasted = payload["url"].as_str().unwrap_or_default().trim();
                let url = url::Url::parse(pasted)
                    .map_err(|_| invalid("Paste the full address the browser returned to"))?;
                flow.set_returned(oauth2::returned_parameters(&url));
                self.oauth2_progress(session).await
            }
            "status" => self.oauth2_progress(session).await,
            "open" => {
                let flow = self.oauth2_flows.get(session)?;
                Ok(json!({"opened": oauth2_flow::open_browser(flow.authorization_url.as_str())}))
            }
            "cancel" => {
                self.oauth2_flows.remove(session);
                Ok(json!({"state": "cancelled"}))
            }
            other => Err(invalid(format!("Unknown sign-in action: {other}"))),
        }
    }
    /// Turns the provider's answer into a token once it arrives, and reports the sign-in.
    async fn oauth2_progress(&self, session: &str) -> Result<Value> {
        let flow = self.oauth2_flows.get(session)?;
        if flow.outcome().is_none() {
            if let Some(parameters) = flow.take_returned() {
                let obtained = match flow.read(&parameters, now_ms()) {
                    Ok(oauth2::Returned::Token(token)) => Ok(token),
                    Ok(oauth2::Returned::Code(code)) => {
                        let exchange = oauth2::Exchange::Code {
                            code: &code,
                            redirect_uri: &flow.redirect_uri,
                            verifier: flow.verifier.as_deref(),
                        };
                        match oauth2::token_request(&flow.auth, exchange) {
                            Ok(request) => self.post_token(request).await,
                            Err(error) => Err(error),
                        }
                    }
                    Err(error) => Err(error),
                };
                let name = auth::text(flow.auth.get("tokenName"));
                let outcome = match obtained {
                    Ok(token) => oauth2_tokens::store(&self.vault, &name, &token).await,
                    Err(error) => Err(error),
                };
                flow.finish(outcome.map_err(|error| error.to_string()));
            } else if flow.expired() {
                flow.finish(Err(
                    "The sign-in was not completed within five minutes".into()
                ));
            }
        }
        Ok(match flow.outcome() {
            None => json!({"state": "waiting"}),
            Some(Ok(token)) => {
                self.oauth2_flows.remove(session);
                json!({"state": "done", "token": token})
            }
            Some(Err(error)) => {
                self.oauth2_flows.remove(session);
                json!({"state": "error", "error": error})
            }
        })
    }
    /// Sends a token request and reads the answer.
    async fn post_token(&self, request: oauth2::TokenRequest) -> Result<Value> {
        let client = self.client_for(&request.url).await?;
        let mut builder = client.post(request.url.clone());
        for (name, value) in &request.headers {
            builder = builder.header(name, value);
        }
        let body = url::form_urlencoded::Serializer::new(String::new())
            .extend_pairs(&request.form)
            .finish();
        let response = builder
            .header("content-type", "application/x-www-form-urlencoded")
            .body(body)
            .send()
            .await
            .map_err(transport::request_error)?;
        if response.status().is_redirection() {
            return Err(invalid("The token endpoint answered with a redirect"));
        }
        let status = response.status().as_u16();
        let text = read_limited(response, 1024 * 1024).await?;
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|elapsed| elapsed.as_millis() as u64)
            .unwrap_or_default();
        oauth2::token_response(status, &text, now)
    }
    async fn oauth_token(&self, payload: &Value) -> Result<Value> {
        let url = payload["url"]
            .as_str()
            .and_then(|url| url::Url::parse(url).ok())
            .ok_or_else(|| invalid("Enter the full token endpoint URL"))?;
        if !["http", "https"].contains(&url.scheme()) {
            return Err(invalid("HTTP token endpoint required"));
        }
        let form = {
            let mut form = url::form_urlencoded::Serializer::new(String::new());
            for (key, value) in payload["fields"].as_object().into_iter().flatten() {
                let value = match value {
                    Value::Null => continue,
                    Value::String(text) if text.is_empty() => continue,
                    Value::String(text) => text.clone(),
                    other => other.to_string(),
                };
                form.append_pair(key, &value);
            }
            form.finish()
        };
        let client = self.client_for(&url).await?;
        let mut request = client.post(url);
        for (key, value) in header_pairs(&payload["headers"]) {
            request = request.header(key, value);
        }
        let response = request
            .header("content-type", "application/x-www-form-urlencoded")
            .header("accept", "application/json")
            .body(form)
            .send()
            .await
            .map_err(transport::request_error)?;
        if response.status().is_redirection() {
            return Err(invalid("The token endpoint answered with a redirect"));
        }
        let status = response.status().as_u16();
        let text = read_limited(response, 1024 * 1024).await?;
        let body = serde_json::from_str::<Value>(&text).unwrap_or_else(|_| {
            let fields: Map<String, Value> = url::form_urlencoded::parse(text.as_bytes())
                .map(|(k, v)| (k.into_owned(), Value::String(v.into_owned())))
                .collect();
            if fields.is_empty() || text.to_lowercase().contains("<html") {
                json!({"text": text})
            } else {
                Value::Object(fields)
            }
        });
        Ok(json!({"status": status, "body": body}))
    }
}
fn header_pairs(value: &Value) -> Vec<(String, String)> {
    let text = |value: &Value| match value {
        Value::String(text) => text.clone(),
        Value::Null => String::new(),
        other => other.to_string(),
    };
    match value {
        Value::Object(map) => map.iter().map(|(k, v)| (k.clone(), text(v))).collect(),
        Value::Array(rows) => rows
            .iter()
            .filter(|row| row["enabled"] != false)
            .filter_map(|row| {
                row["key"]
                    .as_str()
                    .filter(|k| !k.is_empty())
                    .map(|k| (k.to_string(), text(&row["value"])))
            })
            .collect(),
        _ => Vec::new(),
    }
}

#[async_trait]
impl ExecutionGateway for Engine {
    async fn execute(&self, operation: Operation, payload: Value) -> Result<Value> {
        match operation {
            Operation::Request => {
                let payload = self.prepare_oauth2(payload).await;
                self.runs.request(payload, true).await
            }
            Operation::Run if payload["action"] == "status" => self
                .runs
                .status(id(&payload), &runner::Cursor::from_value(&payload["after"])),
            Operation::Run => {
                let payload = self.prepare_oauth2(payload).await;
                let job = self.runs.start(payload)?;
                Ok(json!({"id": job.id(), "state": "running"}))
            }
            Operation::Cancel => self.runs.cancel(id(&payload)),
            Operation::Import => interchange::import(&payload),
            Operation::Codegen => interchange::generate(&payload),
            Operation::RealtimeConnect => self.realtime.connect(&payload).await,
            Operation::RealtimeSend => self.realtime.send(&payload),
            Operation::RealtimeClose => self.realtime.disconnect(&payload),
            Operation::RealtimePoll => self.realtime.poll(&payload),
            Operation::RealtimeList => Ok(self.realtime.list()),
            Operation::Grpc => grpc::request(&payload, &self.egress, &self.mocks.ports()).await,
            Operation::MockStart => self.mocks.start(&payload).await,
            Operation::MockStop => self.mocks.stop(&payload),
            Operation::MockList => Ok(self.mocks.list()),
            Operation::DatasetImport => self.datasets.import(&payload),
            Operation::DatasetQuery => self.dataset_query(payload).await,
            Operation::DatasetSchema => {
                let mut payload = payload;
                payload["sql"] = json!("SELECT * FROM data LIMIT 1");
                self.dataset_query(payload).await
            }
            Operation::DatasetDelete => self.datasets.remove(&payload),
            Operation::DatasetParse => {
                let rows = datasets::parse_rows(&payload)?;
                let total = rows.len();
                Ok(
                    json!({"rows": rows.into_iter().take(10_000).collect::<Vec<_>>(), "total": total}),
                )
            }
            Operation::McpRequest => self.mcp(&payload).await,
            Operation::OauthToken => self.oauth_token(&payload).await,
            Operation::Oauth2Token => self.oauth2_token(&payload).await,
            Operation::Oauth2Authorize => self.oauth2_authorize(&payload).await,
            Operation::Oauth2Tokens => self.oauth2_tokens(&payload).await,
            Operation::CookiesList => {
                Ok(json!({"cookies": self.runs.jars.list(&cookie_scope(&payload))}))
            }
            Operation::CookiesClear => {
                self.runs.jars.clear(&cookie_scope(&payload));
                Ok(json!({"cleared": true}))
            }
            Operation::Performance if payload["action"] == "status" => {
                self.performance.status(id(&payload))
            }
            Operation::Performance => self.performance.start(&payload),
            Operation::PerformanceCancel => self.performance.cancel(id(&payload)),
        }
    }
}

#[async_trait]
impl SecretVault for Engine {
    /// OAuth 2.0 tokens are kept under reserved names, managed only through `oauth2.tokens`.
    async fn put(&self, name: &str, value: &str) -> Result<()> {
        if oauth2_tokens::is_reserved(name) {
            return Err(invalid(
                "Names starting with nexo-oauth2 are reserved for OAuth 2.0 tokens",
            ));
        }
        self.vault.put(name, value).await
    }
    async fn remove(&self, name: &str) -> Result<()> {
        if oauth2_tokens::is_reserved(name) {
            return Err(invalid("Delete OAuth 2.0 tokens in Manage Tokens"));
        }
        self.vault.remove(name).await
    }
    /// Requests may reference a token's access or ID token, never its details (which hold
    /// the refresh token).
    async fn resolve(&self, name: &str) -> Result<String> {
        if name.trim().starts_with("nexo-oauth2-details:") {
            return Err(Error::NotFound);
        }
        self.vault.get(name).await
    }
    async fn names(&self) -> Result<Vec<String>> {
        Ok(self
            .vault
            .names()
            .await?
            .into_iter()
            .filter(|name| !oauth2_tokens::is_reserved(name))
            .collect())
    }
}
