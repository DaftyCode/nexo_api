//! Mock servers listening on loopback with validated examples.
use axum::{
    Router,
    body::Body,
    extract::{Request, State},
    http::{HeaderName, HeaderValue, StatusCode},
    response::Response,
};
use futures_util::StreamExt;
use nexo_domain::{Error, Result};
use serde_json::{Value, json};
use std::{
    collections::{HashMap, VecDeque},
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio_util::sync::CancellationToken;

const MAX_MOCKS: usize = 10;
const MAX_EXAMPLES: usize = 200;
const MAX_CALLS: usize = 200;
const MAX_RECORDED_BODY: usize = 64 * 1024;

fn invalid(message: impl Into<String>) -> Error {
    Error::Validation(message.into())
}

#[derive(Clone, Debug)]
pub struct Example {
    method: Option<String>,
    path: String,
    status: StatusCode,
    headers: Vec<(HeaderName, HeaderValue)>,
    delay: Duration,
    body: String,
}

/// Validates examples before a server starts, so a bad example cannot break a running mock.
pub fn normalize_examples(examples: &Value) -> Result<Vec<Example>> {
    let examples = match examples {
        Value::Null => return Ok(Vec::new()),
        Value::Array(examples) => examples,
        _ => return Err(invalid("Mock examples must be an array")),
    };
    if examples.len() > MAX_EXAMPLES {
        return Err(invalid(format!(
            "A mock supports at most {MAX_EXAMPLES} examples"
        )));
    }
    examples
        .iter()
        .enumerate()
        .map(|(index, example)| {
            let position = format!("Example {}", index + 1);
            if !example.is_object() {
                return Err(invalid(format!("{position} must be an object")));
            }
            let method = match &example["method"] {
                Value::String(method) if !method.is_empty() => {
                    let method = method.to_uppercase();
                    let valid = method.len() <= 32
                        && method.starts_with(|c: char| c.is_ascii_uppercase())
                        && method.chars().all(|c| {
                            c.is_ascii_uppercase() || c.is_ascii_digit() || c == '_' || c == '-'
                        });
                    if !valid {
                        return Err(invalid(format!("{position}: invalid HTTP method")));
                    }
                    Some(method)
                }
                _ => None,
            };
            let path = example["path"].as_str().unwrap_or("*").to_string();
            if path != "*" && !path.starts_with('/') {
                return Err(invalid(format!("{position}: path must start with /")));
            }
            let status = match &example["status"] {
                Value::Null => 200,
                value => value
                    .as_u64()
                    .or_else(|| value.as_str().and_then(|s| s.parse().ok()))
                    .filter(|status| (100..=599).contains(status))
                    .ok_or_else(|| {
                        invalid(format!(
                            "{position}: status must be an integer between 100 and 599"
                        ))
                    })?,
            };
            let mut headers = Vec::new();
            for (name, value) in example["headers"].as_object().into_iter().flatten() {
                let text = match value {
                    Value::String(text) => text.clone(),
                    other => other.to_string(),
                };
                let header = HeaderName::try_from(name.as_str())
                    .ok()
                    .zip(HeaderValue::try_from(text).ok())
                    .ok_or_else(|| {
                        invalid(format!("{position}: invalid header {}", json!(name)))
                    })?;
                headers.push(header);
            }
            let delay = example["delay"]
                .as_f64()
                .unwrap_or(0.0)
                .clamp(0.0, 30_000.0);
            let body = match &example["body"] {
                Value::String(text) => text.clone(),
                other => other.to_string(),
            };
            Ok(Example {
                method,
                path,
                status: StatusCode::from_u16(status as u16)
                    .map_err(|_| invalid(format!("{position}: invalid status")))?,
                headers,
                delay: Duration::from_millis(delay as u64),
                body,
            })
        })
        .collect()
}

struct Mock {
    port: u16,
    calls: Arc<Mutex<VecDeque<Value>>>,
    stop: CancellationToken,
}
#[derive(Clone)]
struct Served {
    examples: Arc<Vec<Example>>,
    calls: Arc<Mutex<VecDeque<Value>>>,
}

#[derive(Default)]
pub struct Mocks {
    servers: Mutex<HashMap<String, Mock>>,
}
impl Mocks {
    pub async fn start(&self, payload: &Value) -> Result<Value> {
        let id = payload["id"]
            .as_str()
            .map(String::from)
            .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
        {
            let servers = self.servers.lock().unwrap_or_else(|e| e.into_inner());
            if servers.contains_key(&id) {
                return Err(invalid("Mock already running"));
            }
            if servers.len() >= MAX_MOCKS {
                return Err(invalid(format!(
                    "Stop a mock first; at most {MAX_MOCKS} can run at once"
                )));
            }
        }
        let examples = normalize_examples(&payload["examples"])?;
        let port = match &payload["port"] {
            Value::Null => 0,
            value => value
                .as_u64()
                .or_else(|| value.as_str().map(|s| s.parse().unwrap_or(u64::MAX)))
                .filter(|port| *port <= 65535)
                .ok_or_else(|| invalid("Invalid mock port"))? as u16,
        };
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", port))
            .await
            .map_err(|error| invalid(format!("The mock cannot listen on port {port}: {error}")))?;
        let actual = listener
            .local_addr()
            .map_err(|error| Error::Infrastructure(error.to_string()))?
            .port();
        let calls = Arc::new(Mutex::new(VecDeque::new()));
        let served = Served {
            examples: Arc::new(examples),
            calls: calls.clone(),
        };
        let stop = CancellationToken::new();
        let app = Router::new().fallback(respond).with_state(served);
        let shutdown = stop.clone();
        tokio::spawn(async move {
            let _ = axum::serve(listener, app)
                .with_graceful_shutdown(async move { shutdown.cancelled().await })
                .await;
        });
        let mut servers = self.servers.lock().unwrap_or_else(|e| e.into_inner());
        if servers.contains_key(&id) || servers.len() >= MAX_MOCKS {
            stop.cancel();
            return Err(invalid("Mock already running"));
        }
        servers.insert(
            id.clone(),
            Mock {
                port: actual,
                calls,
                stop,
            },
        );
        Ok(json!({"id": id, "port": actual, "url": format!("http://127.0.0.1:{actual}")}))
    }
    pub fn list(&self) -> Value {
        let servers = self.servers.lock().unwrap_or_else(|e| e.into_inner());
        Value::Array(
            servers
                .iter()
                .map(|(id, mock)| {
                    let calls: Vec<Value> = mock.calls.lock().unwrap_or_else(|e| e.into_inner()).iter().cloned().collect();
                    json!({"id": id, "port": mock.port, "url": format!("http://127.0.0.1:{}", mock.port), "calls": calls})
                })
                .collect(),
        )
    }
    /// Ports of running mocks, which requests may reach even when private egress is blocked.
    pub fn ports(&self) -> Vec<u16> {
        self.servers
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .values()
            .map(|mock| mock.port)
            .collect()
    }
    pub fn stop(&self, payload: &Value) -> Result<Value> {
        let id = payload["id"].as_str().unwrap_or_default();
        let mock = self
            .servers
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(id)
            .ok_or_else(|| invalid("Mock not found"))?;
        mock.stop.cancel();
        Ok(json!({"stopped": true}))
    }
    pub fn close(&self) {
        for (_, mock) in self
            .servers
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .drain()
        {
            mock.stop.cancel();
        }
    }
}

async fn respond(State(served): State<Served>, request: Request) -> Response {
    let method = request.method().as_str().to_string();
    let path = request.uri().path().to_string();
    let mut stream = request.into_body().into_data_stream();
    let mut body = Vec::new();
    while let Some(Ok(chunk)) = stream.next().await {
        if body.len() < MAX_RECORDED_BODY {
            body.extend_from_slice(&chunk[..chunk.len().min(MAX_RECORDED_BODY - body.len())]);
        }
    }
    {
        let mut calls = served.calls.lock().unwrap_or_else(|e| e.into_inner());
        let time = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        calls.push_back(json!({"time": time, "method": method, "path": path, "body": String::from_utf8_lossy(&body)}));
        while calls.len() > MAX_CALLS {
            calls.pop_front();
        }
    }
    let matched = served.examples.iter().find(|e| {
        e.method.as_deref().is_none_or(|m| m == method) && (e.path == path || e.path == "*")
    });
    let Some(example) = matched else {
        return Response::builder()
            .status(StatusCode::NOT_FOUND)
            .header("content-type", "application/json")
            .body(Body::from("{\"error\":\"No matching mock example\"}"))
            .unwrap_or_default();
    };
    if !example.delay.is_zero() {
        tokio::time::sleep(example.delay).await;
    }
    let mut response = Response::new(Body::from(example.body.clone()));
    *response.status_mut() = example.status;
    let headers = response.headers_mut();
    headers.insert("content-type", HeaderValue::from_static("application/json"));
    for (name, value) in &example.headers {
        headers.insert(name.clone(), value.clone());
    }
    response
}

#[cfg(test)]
mod tests;
