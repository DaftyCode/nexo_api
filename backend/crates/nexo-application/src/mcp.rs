//! Model Context Protocol server: JSON-RPC messages answered with the application's use
//! cases. Transports (Streamable HTTP in `nexo-http`) only move messages.
use crate::{Application, mcp_content::Missing, operations::Operation};
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        operations::GitOperation,
        ports::{
            ConnectionReport, DatabaseConnection, DocumentDatabase, ExecutionGateway, SecretVault,
            VersionControl, WorkspaceRepository,
        },
    };
    use async_trait::async_trait;
    use nexo_domain::{
        Document, DocumentId, DocumentKind, DocumentSummary, Result, Revision, SecretSummary,
        Workspace, WorkspaceId, hosts::AllowedHosts,
    };
    use std::sync::{Arc, Mutex};

    /// Workspaces, documents and a vault in memory.
    #[derive(Default)]
    struct Store {
        documents: Mutex<Vec<Document>>,
        secrets: Vec<(String, String)>,
        vault_locked: bool,
    }
    fn workspace(id: &str, name: &str) -> Workspace {
        Workspace {
            id: WorkspaceId::parse(id).unwrap(),
            name: name.into(),
        }
    }
    #[async_trait]
    impl WorkspaceRepository for Store {
        async fn workspaces(&self) -> Result<Vec<Workspace>> {
            Ok(vec![workspace("local", "Main"), workspace("w2", "Team")])
        }
        async fn create_workspace(&self, name: &str) -> Result<Workspace> {
            Ok(workspace(name, name))
        }
        async fn rename_workspace(&self, id: &WorkspaceId, name: &str) -> Result<Workspace> {
            Ok(workspace(id.as_str(), name))
        }
        async fn delete_workspace(&self, _: &WorkspaceId) -> Result<()> {
            Ok(())
        }
        async fn summaries(
            &self,
            workspace: &WorkspaceId,
            kind: Option<DocumentKind>,
        ) -> Result<Vec<DocumentSummary>> {
            Ok(self
                .documents(workspace, kind)
                .await?
                .into_iter()
                .map(|d| DocumentSummary {
                    id: d.id,
                    workspace_id: d.workspace_id,
                    kind: d.kind,
                    name: d.name,
                    revision: d.revision,
                    updated_at: d.updated_at,
                })
                .collect())
        }
        async fn documents(
            &self,
            workspace: &WorkspaceId,
            kind: Option<DocumentKind>,
        ) -> Result<Vec<Document>> {
            Ok(self
                .documents
                .lock()
                .unwrap()
                .iter()
                .filter(|d| &d.workspace_id == workspace && kind.is_none_or(|k| d.kind == k))
                .cloned()
                .collect())
        }
        async fn document(&self, id: &DocumentId) -> Result<Document> {
            self.documents
                .lock()
                .unwrap()
                .iter()
                .find(|d| &d.id == id)
                .cloned()
                .ok_or(Error::NotFound)
        }
        async fn save(&self, document: Document) -> Result<Document> {
            Ok(document)
        }
        async fn delete(&self, _: &DocumentId, _: i64) -> Result<()> {
            Ok(())
        }
        async fn revisions(&self, _: &DocumentId) -> Result<Vec<Revision>> {
            Ok(vec![])
        }
        async fn prune(&self, _: &WorkspaceId, _: DocumentKind, _: usize) -> Result<usize> {
            Ok(0)
        }
    }
    #[async_trait]
    impl ExecutionGateway for Store {
        async fn execute(&self, _: Operation, _: Value) -> Result<Value> {
            Ok(Value::Null)
        }
    }
    #[async_trait]
    impl SecretVault for Store {
        async fn put(&self, _: &str, _: Option<&str>, _: Option<&AllowedHosts>) -> Result<()> {
            Ok(())
        }
        async fn remove(&self, _: &str) -> Result<()> {
            Ok(())
        }
        async fn resolve(&self, name: &str) -> Result<String> {
            self.secrets
                .iter()
                .find(|(n, _)| n == name)
                .map(|(_, v)| v.clone())
                .ok_or(Error::NotFound)
        }
        async fn secrets(&self) -> Result<Vec<SecretSummary>> {
            if self.vault_locked {
                return Err(Error::Infrastructure("vault locked".into()));
            }
            Ok(self
                .secrets
                .iter()
                .map(|(name, _)| SecretSummary {
                    name: name.clone(),
                    allowed_hosts: vec![],
                })
                .chain([SecretSummary {
                    name: "deleted".into(),
                    allowed_hosts: vec![],
                }])
                .collect())
        }
    }
    #[async_trait]
    impl VersionControl for Store {
        async fn execute(&self, _: &WorkspaceId, _: GitOperation, _: Value) -> Result<Value> {
            Ok(Value::Null)
        }
    }
    #[async_trait]
    impl DocumentDatabase for Store {
        async fn test(&self, _: DatabaseConnection) -> Result<ConnectionReport> {
            Err(Error::NotFound)
        }
    }

    fn document(
        id: &str,
        workspace: &str,
        kind: DocumentKind,
        name: &str,
        value: Value,
    ) -> Document {
        Document {
            id: DocumentId::parse(id).unwrap(),
            workspace_id: WorkspaceId::parse(workspace).unwrap(),
            kind,
            name: name.into(),
            revision: 1,
            updated_at: 0,
            value,
        }
    }
    /// A workspace with a collection, an environment, globals and two executions. The vault
    /// value `s3cr3t-value` was pasted literally into the collection and a response.
    fn application(vault_locked: bool) -> Application {
        let mut latest = document(
            "h2",
            "local",
            DocumentKind::History,
            "GET /orders",
            json!({
                "request": {"url": "https://api.test/orders",
                            "headers": [{"key": "Authorization", "value": "Bearer abc"}]},
                "response": {"status": 500, "body": "{\"error\":\"boom\",\"echo\":\"s3cr3t-value\"}"}
            }),
        );
        latest.updated_at = 20;
        let mut older = document(
            "h1",
            "local",
            DocumentKind::History,
            "GET /",
            json!({"response": {"status": 200}}),
        );
        older.updated_at = 10;
        let collection = json!({
            "info": {"name": "Shop"},
            "auth": {"type": "bearer", "bearer": [{"key": "token", "value": "literal-token"}]},
            "variable": [{"key": "note", "value": "uses s3cr3t-value here"}],
            "item": [{"name": "Orders", "item": [
                {"id": "r1", "name": "List orders", "request": {"method": "GET", "url": "{{base}}/orders"}}
            ]}]
        });
        let environment = json!({"values": [
            {"key": "base", "value": "https://api.test"},
            {"key": "password", "value": "hunter22"}
        ]});
        let store = Arc::new(Store {
            documents: Mutex::new(vec![
                document("c1", "local", DocumentKind::Collection, "Shop", collection),
                document("e1", "local", DocumentKind::Environment, "Dev", environment),
                document(
                    "g1",
                    "local",
                    DocumentKind::Globals,
                    "Globals",
                    json!({"values": [{"key": "a", "value": "1"}]}),
                ),
                latest,
                older,
                document(
                    "c2",
                    "w2",
                    DocumentKind::Collection,
                    "Team API",
                    json!({"info": {"name": "Team API"}, "item": []}),
                ),
            ]),
            secrets: vec![
                ("api".into(), "s3cr3t-value".into()),
                ("short".into(), "abc".into()),
            ],
            vault_locked,
        });
        Application::new(
            store.clone(),
            store.clone(),
            store.clone(),
            store.clone(),
            store,
        )
    }
    async fn call(application: &Application, method: &str, params: Value) -> Value {
        application
            .mcp(json!({"jsonrpc": "2.0", "id": 1, "method": method, "params": params}))
            .await
            .body
            .unwrap()
    }
    fn text(reply: &Value) -> String {
        reply["result"]["contents"][0]["text"]
            .as_str()
            .unwrap()
            .to_string()
    }

    #[tokio::test]
    async fn initialize_declares_resources_and_prompts() {
        let application = application(false);
        let reply = call(
            &application,
            "initialize",
            json!({"protocolVersion": "2099-01-01"}),
        )
        .await;
        let result = &reply["result"];
        assert_eq!(result["protocolVersion"], PROTOCOL);
        assert_eq!(result["capabilities"]["resources"]["subscribe"], false);
        assert!(result["capabilities"]["prompts"].is_object());
    }

    #[tokio::test]
    async fn resources_are_listed_for_every_workspace() {
        let application = application(false);
        let reply = call(&application, "resources/list", json!({})).await;
        let resources = reply["result"]["resources"].as_array().unwrap();
        let uris: Vec<&str> = resources
            .iter()
            .map(|r| r["uri"].as_str().unwrap())
            .collect();
        assert_eq!(
            uris,
            [
                "nexo://workspaces/local/collections/c1",
                "nexo://workspaces/local/environments/e1",
                "nexo://workspaces/local/globals",
                "nexo://workspaces/local/history/latest",
                "nexo://workspaces/w2/collections/c2",
            ]
        );
        assert_eq!(resources[0]["name"], "Main / Shop");
        assert_eq!(resources[0]["mimeType"], "application/json");
        let templates = call(&application, "resources/templates/list", json!({})).await;
        assert!(
            templates["result"]["resourceTemplates"][0]["uriTemplate"]
                .as_str()
                .unwrap()
                .ends_with("/collections/{collection}/requests/{request}")
        );
    }

    #[tokio::test]
    async fn resources_are_read_without_secrets() {
        let application = application(false);
        let read = |uri: &str| call(&application, "resources/read", json!({"uri": uri}));

        let collection = read("nexo://workspaces/local/collections/c1").await;
        assert_eq!(
            collection["result"]["contents"][0]["uri"],
            "nexo://workspaces/local/collections/c1"
        );
        let shown = text(&collection);
        assert!(shown.contains("List orders"));
        assert!(!shown.contains("literal-token"));
        assert!(!shown.contains("s3cr3t-value"));
        assert!(shown.contains("uses [REDACTED] here"));

        let request = text(&read("nexo://workspaces/local/collections/c1/requests/r1").await);
        assert!(request.contains("{{base}}/orders"));
        let by_name =
            text(&read("nexo://workspaces/local/collections/c1/requests/List%20orders").await);
        assert_eq!(by_name, request);

        let environment = text(&read("nexo://workspaces/local/environments/e1").await);
        assert!(environment.contains("https://api.test"));
        assert!(!environment.contains("hunter22"));
        assert!(text(&read("nexo://workspaces/local/globals").await).contains("\"a\""));

        let latest = text(&read("nexo://workspaces/local/history/latest").await);
        assert!(latest.contains("boom"));
        assert!(!latest.contains("Bearer abc"));
        assert!(!latest.contains("s3cr3t-value"));

        for missing in [
            "nexo://workspaces/local/collections/missing",
            "nexo://workspaces/w2/collections/c1",
            "nexo://workspaces/local/environments/c1",
            "nexo://workspaces/local/collections/c1/requests/none",
            "nexo://workspaces/w2/globals",
            "nexo://workspaces/w2/history/latest",
            "https://example.com",
        ] {
            let reply = read(missing).await;
            assert_eq!(reply["error"]["code"], -32002, "{missing}");
            assert_eq!(reply["error"]["data"]["uri"], missing);
        }
    }

    #[tokio::test]
    async fn nothing_is_shared_when_the_vault_cannot_be_checked() {
        let application = application(true);
        let reply = call(
            &application,
            "resources/read",
            json!({"uri": "nexo://workspaces/local/collections/c1"}),
        )
        .await;
        assert_eq!(reply["error"]["code"], -32603);
        assert_eq!(reply["error"]["message"], "An internal operation failed");
    }

    #[tokio::test]
    async fn prompts_are_listed_and_embed_their_resource() {
        let application = application(false);
        let listed = call(&application, "prompts/list", json!({})).await;
        let names: Vec<&str> = listed["result"]["prompts"]
            .as_array()
            .unwrap()
            .iter()
            .map(|p| p["name"].as_str().unwrap())
            .collect();
        assert_eq!(
            names,
            ["write_tests", "explain_failure", "document_collection"]
        );

        let tests = call(
            &application,
            "prompts/get",
            json!({"name": "write_tests", "arguments": {"collection": "shop", "request": "List orders"}}),
        )
        .await;
        let messages = &tests["result"]["messages"];
        assert!(
            messages[0]["content"]["text"]
                .as_str()
                .unwrap()
                .contains("pm.test")
        );
        assert_eq!(
            messages[1]["content"]["resource"]["uri"],
            "nexo://workspaces/local/collections/c1/requests/r1"
        );

        let documented = call(
            &application,
            "prompts/get",
            json!({"name": "document_collection", "arguments": {"collection": "Team API"}}),
        )
        .await;
        let instruction = documented["result"]["messages"][0]["content"]["text"]
            .as_str()
            .unwrap();
        assert!(instruction.contains("\"Team API\" (0 requests)"));
        assert_eq!(
            documented["result"]["messages"][1]["content"]["resource"]["uri"],
            "nexo://workspaces/w2/collections/c2"
        );
        let shop = call(
            &application,
            "prompts/get",
            json!({"name": "document_collection", "arguments": {"collection": "c1", "workspace": "Main"}}),
        )
        .await;
        let embedded = shop["result"]["messages"][1]["content"]["resource"]["text"]
            .as_str()
            .unwrap();
        assert!(!embedded.contains("literal-token") && !embedded.contains("s3cr3t-value"));

        let failure = call(
            &application,
            "prompts/get",
            json!({"name": "explain_failure"}),
        )
        .await;
        let embedded = failure["result"]["messages"][1]["content"]["resource"]["text"]
            .as_str()
            .unwrap();
        assert!(embedded.contains("boom"));
        assert!(!embedded.contains("s3cr3t-value"));

        for (params, message) in [
            (
                json!({"name": "write_tests", "arguments": {"collection": "Shop"}}),
                "The argument request is required",
            ),
            (
                json!({"name": "write_tests", "arguments": {"collection": "Nope", "request": "x"}}),
                "There is no collection named Nope",
            ),
            (
                json!({"name": "write_tests", "arguments": {"collection": "Shop", "request": "Nope"}}),
                "There is no request named Nope in Shop",
            ),
            (
                json!({"name": "document_collection", "arguments": {"collection": "Shop", "workspace": "Elsewhere"}}),
                "There is no workspace named Elsewhere",
            ),
            (
                json!({"name": "explain_failure", "arguments": {"workspace": "w2"}}),
                "The workspace Team has no executions yet",
            ),
            (json!({"name": "unknown"}), "Unknown prompt"),
        ] {
            let reply = call(&application, "prompts/get", params.clone()).await;
            assert_eq!(reply["error"]["code"], -32602, "{params}");
            assert_eq!(reply["error"]["message"], message);
        }
    }
}
