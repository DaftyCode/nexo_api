//! Model Context Protocol server: JSON-RPC messages answered with the application's use
//! cases. Transports (Streamable HTTP in `nexo-http`) only move messages.
use crate::{Application, operations::Operation};
use nexo_domain::Error;
use serde_json::{Value, json};

pub const PROTOCOL: &str = "2025-06-18";
const SUPPORTED: [&str; 3] = ["2025-06-18", "2025-03-26", "2024-11-05"];

/// Answer to one transport message: a JSON-RPC body (absent when only notifications were
/// received) and the session created by `initialize`.
#[derive(Debug, Default, PartialEq)]
pub struct Reply {
    pub body: Option<Value>,
    pub session: Option<String>,
}

fn rpc_error(id: Value, code: i64, message: &str) -> Value {
    json!({"jsonrpc": "2.0", "id": id, "error": {"code": code, "message": message}})
}

impl Application {
    /// Handles a single message or a batch.
    pub async fn mcp(&self, payload: Value) -> Reply {
        let batch = payload.is_array();
        let messages = match payload {
            Value::Array(items) if items.is_empty() => {
                return Reply {
                    body: Some(rpc_error(Value::Null, -32600, "Empty batch")),
                    session: None,
                };
            }
            Value::Array(items) => items,
            message => vec![message],
        };
        let mut responses = Vec::new();
        let mut session = None;
        for message in messages {
            // Notifications and client responses are acknowledged without a body.
            if message.get("method").is_none() || message.get("id").is_none() {
                continue;
            }
            if message["method"] == "initialize" {
                session = Some(uuid::Uuid::new_v4().simple().to_string());
            }
            responses.push(self.mcp_call(&message).await);
        }
        let body = match responses.len() {
            0 => None,
            _ if batch => Some(Value::Array(responses)),
            _ => responses.into_iter().next(),
        };
        Reply { body, session }
    }

    async fn mcp_call(&self, message: &Value) -> Value {
        let id = message["id"].clone();
        let params = &message["params"];
        let result = match message["method"].as_str().unwrap_or("") {
            "initialize" => {
                let requested = params["protocolVersion"].as_str().unwrap_or(PROTOCOL);
                let version = if SUPPORTED.contains(&requested) {
                    requested
                } else {
                    PROTOCOL
                };
                json!({
                    "protocolVersion": version,
                    "serverInfo": {"name": "nexo-api", "version": env!("CARGO_PKG_VERSION")},
                    "capabilities": {"tools": {"listChanged": false}}
                })
            }
            "ping" => json!({}),
            "tools/list" => json!({"tools": [
                {"name": "send_request", "description": "Execute an HTTP request using the Nexo runtime",
                 "inputSchema": {"type": "object", "properties": {
                    "request": {"type": "object", "properties": {
                        "method": {"type": "string"}, "url": {"type": "string"},
                        "headers": {"type": "array"}, "body": {"type": "string"}},
                     "required": ["url"]},
                    "workspace": {"type": "string"}},
                  "required": ["request"]}},
                {"name": "list_workspaces", "description": "List your workspaces",
                 "inputSchema": {"type": "object", "properties": {}}}
            ]}),
            "tools/call" => {
                let outcome = match params["name"].as_str().unwrap_or("") {
                    "send_request" => {
                        let arguments = params["arguments"].clone();
                        if arguments["request"]["url"].is_string() {
                            self.execute(Operation::Request, arguments).await
                        } else {
                            Err(Error::Validation(
                                "arguments.request.url is required".into(),
                            ))
                        }
                    }
                    "list_workspaces" => self.workspaces().await.and_then(|workspaces| {
                        serde_json::to_value(workspaces)
                            .map_err(|error| Error::Infrastructure(error.to_string()))
                    }),
                    _ => return rpc_error(id, -32602, "Unknown tool"),
                };
                match outcome {
                    Ok(value) => {
                        json!({"content": [{"type": "text", "text": value.to_string()}], "isError": false})
                    }
                    Err(Error::Infrastructure(error)) => {
                        tracing::error!(%error, "MCP tool failure");
                        json!({"content": [{"type": "text", "text": "An internal operation failed"}], "isError": true})
                    }
                    Err(error) => {
                        json!({"content": [{"type": "text", "text": error.to_string()}], "isError": true})
                    }
                }
            }
            _ => return rpc_error(id, -32601, "Method not found"),
        };
        json!({"jsonrpc": "2.0", "id": id, "result": result})
    }
}
