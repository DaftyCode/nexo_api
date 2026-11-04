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

pub mod collection;
pub mod datasets;
pub mod egress;
pub mod grpc;
pub mod interchange;
pub mod mocks;
pub mod mqtt;
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
            egress,
            mocks,
            runs,
        })
    }
    /// Stops connections, mocks and executions.
    pub fn close(&self) {
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
            Operation::Request => self.runs.request(payload, true).await,
            Operation::Run if payload["action"] == "status" => self
                .runs
                .status(id(&payload), &runner::Cursor::from_value(&payload["after"])),
            Operation::Run => {
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
    async fn put(&self, name: &str, value: &str) -> Result<()> {
        self.vault.put(name, value).await
    }
    async fn remove(&self, name: &str) -> Result<()> {
        self.vault.remove(name).await
    }
    async fn resolve(&self, name: &str) -> Result<String> {
        self.vault.get(name).await
    }
    async fn names(&self) -> Result<Vec<String>> {
        self.vault.names().await
    }
}
