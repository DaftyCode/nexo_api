//! The tools the AI assistant reads with (IA-01): what the person has open (the request and
//! its last response, the SQL script, the MongoDB query), the requests of its collection, and
//! the SQL and MongoDB connections agents may read, with the rules and limits of MCP. Every
//! tool only reads. What it gives is masked as for MCP agents (credentials as in a Git
//! export, the masking sets marked for agents) and carries no value of the vault.
use crate::{
    Application,
    mcp::{self, find_request, shareable},
    vault::redact_secrets,
};
use nexo_domain::{DocumentKind, Error, Result, WorkspaceId};
use serde_json::{Map, Value, json};

/// Characters of a response body, a script or an error read at most.
const MAX_TEXT: usize = 20_000;
/// Requests of a collection listed at most.
const MAX_REQUESTS: usize = 500;
/// What a response keeps for the model.
const RESPONSE_FIELDS: [&str; 10] = [
    "status",
    "statusText",
    "headers",
    "body",
    "time",
    "size",
    "error",
    "assertions",
    "logs",
    "truncated",
];

fn tool(name: &str, description: &str, properties: Value, required: &[&str]) -> Value {
    json!({"name": name, "description": description, "inputSchema":
        {"type": "object", "properties": properties, "required": required}})
}

/// The tools offered beside a place: `request`, `sql` or `mongo`.
pub(crate) fn catalog(place: &str) -> Vec<Value> {
    let mut tools = vec![tool(
        "read_open",
        "Read what the person has open in Nexo now: the request, the SQL script or the MongoDB query, the connection and the last error. Call it first when the question is about this request, query or error.",
        json!({}),
        &[],
    )];
    match place {
        "request" => tools.extend([
            tool(
                "read_response",
                "The last response of the open request: status, time, headers, test results and body (cut to 20,000 characters).",
                json!({}),
                &[],
            ),
            tool(
                "list_requests",
                "The requests of the collection of the open request: folder, name, method and URL.",
                json!({}),
                &[],
            ),
            tool(
                "read_request",
                "A request of that collection by its name: method, URL, headers, body and scripts, with credentials hidden.",
                json!({"name": {"type": "string"}}),
                &["name"],
            ),
        ]),
        "sql" => tools.extend(mcp::sql_tools()),
        "mongo" => tools.extend(mcp::mongo_tools()),
        _ => {}
    }
    tools
}

/// A text cut to its limit, saying so.
fn cut(text: &str) -> Value {
    match text.char_indices().nth(MAX_TEXT) {
        Some((end, _)) => json!(format!("{}… [cut at {MAX_TEXT} characters]", &text[..end])),
        None => json!(text),
    }
}

/// Folder, name, method and URL of each request of a collection, depth first.
fn requests(items: &Value, folder: &str, found: &mut Vec<Value>) {
    for item in items.as_array().into_iter().flatten() {
        if found.len() >= MAX_REQUESTS {
            return;
        }
        let name = item["name"].as_str().unwrap_or_default();
        if item.get("request").is_some() {
            let url = &item["request"]["url"];
            found.push(json!({"folder": folder, "name": name,
                "method": item["request"]["method"].as_str().unwrap_or("GET"),
                "url": url["raw"].as_str().or(url.as_str()).unwrap_or_default()}));
        } else {
            let inner = if folder.is_empty() {
                name.to_owned()
            } else {
                format!("{folder} / {name}")
            };
            requests(&item["item"], &inner, found);
        }
    }
}

impl Application {
    /// `ai.tool`: one tool the model asked for. Its answer, or why it failed, is text for
    /// the model: `{text, error}`.
    pub(crate) async fn ai_tool(&self, payload: &Map<String, Value>) -> Result<Value> {
        let field = |name: &str| {
            payload
                .get(name)
                .and_then(Value::as_str)
                .unwrap_or_default()
        };
        let workspace = WorkspaceId::parse(match field("workspace") {
            "" => "local",
            given => given,
        })?;
        let mut input = match payload.get("input") {
            Some(Value::Object(input)) => input.clone(),
            _ => Map::new(),
        };
        input.insert("workspace".into(), json!(workspace.as_str()));
        let input = Value::Object(input);
        let context = payload.get("context").cloned().unwrap_or(Value::Null);
        let bodies = payload
            .get("bodies")
            .and_then(Value::as_bool)
            .unwrap_or(true);
        let name = field("name");
        let outcome = match name {
            "read_open" => self.ai_open(&workspace, &context).await,
            "read_response" => self.ai_response(&workspace, &context, bodies).await,
            "list_requests" => self.ai_requests(&workspace, &context, None).await,
            "read_request" => {
                let wanted = input["name"].as_str().unwrap_or_default().to_owned();
                self.ai_requests(&workspace, &context, Some(&wanted)).await
            }
            _ => match self.mongo_tool(name, &input).await {
                Some(outcome) => outcome,
                None => match self.sql_tool(name, &input).await {
                    Some(outcome) => outcome,
                    None => Err(Error::Validation(format!("{name} is not a tool of Nexo"))),
                },
            },
        };
        Ok(match outcome {
            Ok(value) => json!({"text": self.redacted(&value).await?, "error": false}),
            Err(Error::Infrastructure(error)) => {
                tracing::error!(%error, "AI tool failure");
                json!({"text": "An internal operation failed", "error": true})
            }
            Err(error) => {
                let values = self.vault_values().await?;
                json!({"text": redact_secrets(json!(error.to_string()), &values), "error": true})
            }
        })
    }

    /// `read_open`: the request (as it would be shared) or the script, query and connection
    /// open, with whether agents may read that connection.
    async fn ai_open(&self, workspace: &WorkspaceId, context: &Value) -> Result<Value> {
        let mut open = Map::new();
        if context["request"].is_object() {
            let masked = self
                .mask_for_agents(workspace, vec![shareable(&context["request"])])
                .await?;
            open.insert(
                "request".into(),
                masked.into_iter().next().unwrap_or_default(),
            );
        }
        for name in [
            "connection",
            "engine",
            "database",
            "collection",
            "script",
            "query",
            "error",
            "plan",
        ] {
            if let Some(text) = context[name]
                .as_str()
                .filter(|text| !text.trim().is_empty())
            {
                open.insert(name.into(), cut(text));
            }
        }
        if let Some(connection) = context["connection"].as_str() {
            let readable = match context["place"].as_str() {
                Some("mongo") => self.mcp_connections(workspace).await?,
                _ => self.mcp_sql_connections(workspace).await?,
            }
            .iter()
            .any(|document| document.name == connection || document.id.as_str() == connection);
            open.insert("readableByTools".into(), json!(readable));
            if !readable {
                open.insert("note".into(), json!("The tools cannot read this connection: the person can turn on «Let MCP agents read it (never write)» in its General tab."));
            }
        }
        if open.is_empty() {
            return Err(Error::Validation(
                "Nothing is open beside the assistant".into(),
            ));
        }
        Ok(Value::Object(open))
    }

    /// `read_response`: the last response of the open request, masked for agents, its body
    /// left out when the person keeps bodies on this computer.
    async fn ai_response(
        &self,
        workspace: &WorkspaceId,
        context: &Value,
        bodies: bool,
    ) -> Result<Value> {
        let Some(given) = context["response"].as_object() else {
            return Err(Error::Validation(
                "The open request has no response yet: send it first".into(),
            ));
        };
        let kept: Map<String, Value> = RESPONSE_FIELDS
            .iter()
            .filter_map(|name| Some((name.to_string(), given.get(*name)?.clone())))
            .collect();
        let mut response = shareable(&Value::Object(kept));
        if !bodies {
            response["body"] =
                json!("[not sent: the person keeps response bodies on this computer]");
            return Ok(response);
        }
        if given.get("bodyEncoding").and_then(Value::as_str) == Some("base64") {
            response["body"] = json!("[a binary body]");
            return Ok(response);
        }
        let mut response = self.mask_response_for_agents(workspace, response).await?;
        response["body"] = cut(response["body"].as_str().unwrap_or_default());
        Ok(response)
    }

    /// `list_requests` and `read_request`: the collection of the open request.
    async fn ai_requests(
        &self,
        workspace: &WorkspaceId,
        context: &Value,
        wanted: Option<&str>,
    ) -> Result<Value> {
        let id = context["collectionId"].as_str().unwrap_or_default();
        let collection = self
            .owned(workspace, id, DocumentKind::Collection)
            .await
            .map_err(|_| {
                Error::Validation("The open request is not saved in a collection".into())
            })?;
        let Some(wanted) = wanted else {
            let mut found = Vec::new();
            requests(&collection.value["item"], "", &mut found);
            return Ok(json!({"collection": collection.name, "requests": found}));
        };
        let request = find_request(&collection.value["item"], wanted).ok_or_else(|| {
            Error::Validation(format!("The collection has no request named {wanted}"))
        })?;
        let masked = self
            .mask_for_agents(workspace, vec![shareable(request)])
            .await?;
        Ok(masked.into_iter().next().unwrap_or_default())
    }
}
