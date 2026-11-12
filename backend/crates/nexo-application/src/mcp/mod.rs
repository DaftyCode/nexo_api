//! Model Context Protocol server: JSON-RPC messages answered with the application's use
//! cases. Transports (Streamable HTTP in `nexo-http`) only move messages.
//!
//! Resources (`nexo://` collections, requests, environments, globals and the last
//! execution) and prompts built on them share nothing secret: credentials in
//! authorizations, credential headers and sensitive variables are masked as in a Git export,
//! and every vault value that still appears is replaced before the text is sent.
mod prompts;
mod resources;
mod share;
#[cfg(test)]
mod tests;
mod uri;

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

/// An application error as a JSON-RPC error; internal details stay in the log.
fn failure(id: Value, error: Error) -> Value {
    match error {
        Error::Infrastructure(error) => {
            tracing::error!(%error, "MCP failure");
            rpc_error(id, -32603, "An internal operation failed")
        }
        other => rpc_error(id, -32603, &other.to_string()),
    }
}
/// What a read or a prompt could not find.
fn missing_error(id: Value, missing: Missing, uri: &str) -> Value {
    match missing {
        Missing::Resource => {
            let mut error = rpc_error(id, -32002, "Resource not found");
            if !uri.is_empty() {
                error["error"]["data"] = json!({"uri": uri});
            }
            error
        }
        Missing::Params(message) => rpc_error(id, -32602, &message),
        Missing::Failure(error) => failure(id, error),
    }
}

/// What a prompt or a read could not find, for a JSON-RPC error.
pub enum Missing {
    /// `-32002`: no such resource.
    Resource,
    /// `-32602`: invalid params, with the reason.
    Params(String),
    /// Anything else: an error of the application.
    Failure(Error),
}
impl From<Error> for Missing {
    fn from(error: Error) -> Self {
        match error {
            Error::NotFound => Missing::Resource,
            other => Missing::Failure(other),
        }
    }
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
                    "capabilities": {
                        "tools": {"listChanged": false},
                        "resources": {"subscribe": false, "listChanged": false},
                        "prompts": {"listChanged": false}
                    }
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
            "resources/list" => match self.mcp_resources().await {
                Ok(resources) => resources,
                Err(error) => return failure(id, error),
            },
            "resources/templates/list" => Self::mcp_resource_templates(),
            "resources/read" => {
                let uri = params["uri"].as_str().unwrap_or("");
                match self.mcp_read(uri).await {
                    Ok(contents) => contents,
                    Err(missing) => return missing_error(id, missing, uri),
                }
            }
            "prompts/list" => Self::mcp_prompts(),
            "prompts/get" => match self.mcp_prompt(params).await {
                Ok(prompt) => prompt,
                Err(missing) => return missing_error(id, missing, ""),
            },
            _ => return rpc_error(id, -32601, "Method not found"),
        };
        json!({"jsonrpc": "2.0", "id": id, "result": result})
    }
}
