//! Request execution engine: HTTP, scripts, protocols, mocks, datasets and the secret vault.
//!
//! It runs inside the Nexo process. Every network destination passes the egress policy and
//! scripts run in a QuickJS sandbox without host access.
use async_trait::async_trait;
use nexo_application::{
    operations::Operation,
    ports::{ExecutionGateway, SecretVault},
};
use nexo_domain::{Error, Result, SecretSummary, hosts::AllowedHosts};
use serde_json::{Map, Value, json};
use std::{path::Path, sync::Arc, time::Duration};

pub mod api_spec;
pub mod auth;
pub mod collection;
pub mod cookies;
pub mod datasets;
pub mod egress;
pub mod files;
mod gateway;
pub mod graphql_sse;
pub mod graphql_ws;
pub mod grpc;
pub mod grpc_reflection;
pub mod hex;
pub mod interchange;
pub mod kafka;
pub mod mocks;
pub mod mqtt;
pub mod oauth2;
pub mod oauth2_flow;
mod oauth2_prepare;
mod oauth2_sign_in;
pub mod oauth2_tokens;
pub mod performance;
pub mod realtime;
pub mod runner;
pub mod scripts;
pub mod secret_hosts;
pub mod socketio;
pub mod tls;
mod token_requests;
pub mod transport;
pub mod vault;

use crate::{
    datasets::Datasets,
    egress::Policy,
    mocks::Mocks,
    performance::Performance,
    realtime::Realtime,
    runner::{Context, Jars, Runs, ScriptDatabases, cookie_scope},
    transport::{guarded_client, parse_url, read_limited},
    vault::{Vault, load_master_key},
};

fn invalid(message: impl Into<String>) -> Error {
    Error::Validation(message.into())
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
    vault: Arc<Vault>,
    oauth2_flows: oauth2_flow::Flows,
    databases: ScriptDatabases,
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
        let vault = Arc::new(Vault::new(data.join("vault"), key, "local"));
        let databases = ScriptDatabases::default();
        let runs = Arc::new(Runs::new(
            Arc::new(Jars::new(data.join("cookies"))),
            Context {
                egress: egress.clone(),
                loopback_ports: ports.clone(),
                vault: Some(vault.clone()),
                databases: databases.clone(),
            },
        ));
        Ok(Self {
            realtime: Realtime::new(egress.clone(), ports),
            datasets: Arc::new(Datasets::new(data.join("datasets"))),
            performance: Performance::new(runs.clone()),
            vault,
            oauth2_flows: oauth2_flow::Flows::default(),
            databases,
            egress,
            mocks,
            runs,
        })
    }
    /// Lets scripts reach the databases of a workspace (`nx.mongo`) through the application.
    pub fn connect_databases(
        &self,
        databases: std::sync::Weak<dyn nexo_application::ports::ScriptDatabase>,
    ) {
        self.databases.connect(databases);
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
