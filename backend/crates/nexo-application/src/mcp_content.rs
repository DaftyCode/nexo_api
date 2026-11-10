//! What the MCP server shares besides tools: resources (`nexo://` collections, requests,
//! environments, globals and the last execution) and prompts built on them.
//!
//! Nothing secret leaves: credentials in authorizations, credential headers and sensitive
//! variables are masked as in a Git export, and every vault value that still appears is
//! replaced before the text is sent.
use crate::Application;
use nexo_domain::{Document, DocumentKind, Error, Result, Workspace, WorkspaceId};
use serde_json::{Value, json};

pub const MASKED: &str = "••••••";
pub const REDACTED: &str = "[REDACTED]";
const SCHEME: &str = "nexo://workspaces/";
const JSON: &str = "application/json";

/// Authorization types whose rows may hold credentials.
const AUTH_TYPES: [&str; 13] = [
    "basic", "bearer", "apikey", "oauth2", "digest", "oauth1", "awsv4", "hawk", "ntlm", "jwt",
    "asap", "edgegrid", "wsse",
];
/// Rows of those types that are credentials.
const SECRET_AUTH_KEYS: [&str; 17] = [
    "token",
    "password",
    "value",
    "accessToken",
    "clientSecret",
    "refreshToken",
    "code_verifier",
    "consumerSecret",
    "tokenSecret",
    "privateKey",
    "accessTokenSecret",
    "secretKey",
    "secretAccessKey",
    "sessionToken",
    "authKey",
    "secret",
    "idToken",
];
const SENSITIVE_HEADERS: [&str; 9] = [
    "authorization",
    "proxy-authorization",
    "cookie",
    "set-cookie",
    "x-api-key",
    "api-key",
    "x-auth-token",
    "private-token",
    "x-access-token",
];

/// A value without its secret: empty values and `{{references}}` stay, they hold none.
fn hide(value: &Value) -> Value {
    match value.as_str() {
        Some("") => value.clone(),
        Some(text) if is_reference(text) => value.clone(),
        _ if value.is_null() => Value::Null,
        _ => json!(MASKED),
    }
}
fn is_reference(text: &str) -> bool {
    let text = text.trim();
    text.starts_with("{{") && text.ends_with("}}") && !text[2..text.len() - 2].contains(['{', '}'])
}
/// Variable names that hold credentials, as the interface marks them.
fn sensitive_name(name: &str) -> bool {
    let name = name.to_ascii_lowercase();
    ["password", "secret", "token", "authorization", "credential"]
        .iter()
        .any(|word| name.contains(word))
        || [
            "apikey",
            "api_key",
            "api-key",
            "privatekey",
            "private_key",
            "private-key",
        ]
        .iter()
        .any(|word| name.contains(word))
}
fn masked_rows(rows: &[Value], secret: impl Fn(&Value) -> bool) -> Value {
    Value::Array(
        rows.iter()
            .map(|row| match row {
                Value::Object(fields) if secret(row) && fields.contains_key("value") => {
                    let mut fields = fields.clone();
                    fields.insert("value".into(), hide(&row["value"]));
                    Value::Object(fields)
                }
                other => shareable(other),
            })
            .collect(),
    )
}

/// A document as it may be shared: masked credentials and no local transport settings.
pub fn shareable(value: &Value) -> Value {
    visit(value, "")
}
fn visit(value: &Value, key: &str) -> Value {
    match value {
        Value::Array(rows) if AUTH_TYPES.contains(&key) => masked_rows(rows, |row| {
            let name = row["key"].as_str().unwrap_or("");
            SECRET_AUTH_KEYS.contains(&name) || (key == "hawk" && name == "key")
        }),
        Value::Array(rows) if key == "header" || key == "headers" => masked_rows(rows, |row| {
            SENSITIVE_HEADERS.contains(
                &row["key"]
                    .as_str()
                    .unwrap_or("")
                    .to_ascii_lowercase()
                    .as_str(),
            )
        }),
        Value::Array(rows) if key == "variable" || key == "values" => masked_rows(rows, |row| {
            row["type"] == "secret"
                || row["secret"] == true
                || sensitive_name(row["key"].as_str().unwrap_or(""))
        }),
        Value::Array(items) => Value::Array(items.iter().map(|item| visit(item, "")).collect()),
        Value::Object(fields) => Value::Object(
            fields
                .iter()
                .filter(|(name, _)| name.as_str() != "nexoTransport")
                .map(|(name, item)| (name.clone(), visit(item, name)))
                .collect(),
        ),
        other => other.clone(),
    }
}

/// Percent-encodes one segment of a `nexo://` URI.
fn encode(segment: &str) -> String {
    segment
        .bytes()
        .map(|byte| {
            if byte.is_ascii_alphanumeric() || b"-_.~".contains(&byte) {
                (byte as char).to_string()
            } else {
                format!("%{byte:02X}")
            }
        })
        .collect()
}
fn decode(segment: &str) -> Option<String> {
    let bytes = segment.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            let hex = segment.get(index + 1..index + 3)?;
            out.push(u8::from_str_radix(hex, 16).ok()?);
            index += 3;
        } else {
            out.push(bytes[index]);
            index += 1;
        }
    }
    String::from_utf8(out).ok()
}
fn uri(workspace: &WorkspaceId, path: &[&str]) -> String {
    let mut uri = format!("{SCHEME}{}", encode(workspace.as_str()));
    for segment in path {
        uri.push('/');
        uri.push_str(segment);
    }
    uri
}

/// A `nexo://` resource that `resources/read` understands.
#[derive(Debug, PartialEq, Eq)]
enum Resource {
    Collection(WorkspaceId, String),
    Request(WorkspaceId, String, String),
    Environment(WorkspaceId, String),
    Globals(WorkspaceId),
    LastExecution(WorkspaceId),
}
fn parse_uri(uri: &str) -> Option<Resource> {
    let rest = uri.strip_prefix(SCHEME)?;
    let parts: Vec<String> = rest.split('/').map(decode).collect::<Option<_>>()?;
    let workspace = WorkspaceId::parse(parts.first()?.clone()).ok()?;
    let parts: Vec<&str> = parts[1..].iter().map(String::as_str).collect();
    Some(match parts.as_slice() {
        ["collections", id] => Resource::Collection(workspace, (*id).into()),
        ["collections", id, "requests", request] => {
            Resource::Request(workspace, (*id).into(), (*request).into())
        }
        ["environments", id] => Resource::Environment(workspace, (*id).into()),
        ["globals"] => Resource::Globals(workspace),
        ["history", "latest"] => Resource::LastExecution(workspace),
        _ => return None,
    })
}

/// The request of a collection with this identifier or name, depth first.
fn find_request<'a>(items: &'a Value, wanted: &str) -> Option<&'a Value> {
    for item in items.as_array()? {
        if item.get("request").is_some()
            && (item["id"].as_str() == Some(wanted)
                || item["name"]
                    .as_str()
                    .is_some_and(|name| name.eq_ignore_ascii_case(wanted)))
        {
            return Some(item);
        }
        if let Some(found) = item
            .get("item")
            .and_then(|items| find_request(items, wanted))
        {
            return Some(found);
        }
    }
    None
}

/// Requests of a collection, for the resource templates' completion and prompt hints.
fn request_count(items: &Value) -> usize {
    items.as_array().map_or(0, |items| {
        items
            .iter()
            .map(|item| usize::from(item.get("request").is_some()) + request_count(&item["item"]))
            .sum()
    })
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
    /// The resources of every workspace.
    pub(crate) async fn mcp_resources(&self) -> Result<Value> {
        let mut resources = Vec::new();
        for workspace in self.workspaces().await? {
            let id = &workspace.id;
            let mut summaries = self.workspaces.summaries(id, None).await?;
            // Collections, environments and globals, each by name: a stable order.
            let rank = |kind: DocumentKind| match kind {
                DocumentKind::Collection => 0,
                DocumentKind::Environment => 1,
                _ => 2,
            };
            summaries.sort_by_key(|summary| (rank(summary.kind), summary.name.to_lowercase()));
            let mut latest: Option<i64> = None;
            for summary in &summaries {
                let document = encode(summary.id.as_str());
                let (path, description) = match summary.kind {
                    DocumentKind::Collection => (
                        vec!["collections", document.as_str()],
                        "Collection with its requests, without credentials",
                    ),
                    DocumentKind::Environment => (
                        vec!["environments", document.as_str()],
                        "Environment variables, with secret values hidden",
                    ),
                    DocumentKind::Globals => (
                        vec!["globals"],
                        "Global variables, with secret values hidden",
                    ),
                    DocumentKind::History => {
                        latest = latest.max(Some(summary.updated_at));
                        continue;
                    }
                    _ => continue,
                };
                resources.push(json!({
                    "uri": uri(id, &path),
                    "name": format!("{} / {}", workspace.name, summary.name),
                    "title": summary.name,
                    "description": description,
                    "mimeType": JSON,
                }));
            }
            if latest.is_some() {
                resources.push(json!({
                    "uri": uri(id, &["history", "latest"]),
                    "name": format!("{} / Last execution", workspace.name),
                    "title": "Last execution",
                    "description": "The last request sent and its response, without credentials",
                    "mimeType": JSON,
                }));
            }
        }
        Ok(json!({"resources": resources}))
    }

    pub(crate) fn mcp_resource_templates() -> Value {
        json!({"resourceTemplates": [{
            "uriTemplate": format!("{SCHEME}{{workspace}}/collections/{{collection}}/requests/{{request}}"),
            "name": "Request",
            "title": "A request of a collection",
            "description": "One request by its ID or name, without credentials",
            "mimeType": JSON,
        }]})
    }

    /// One resource, as text without secrets.
    pub(crate) async fn mcp_read(&self, uri: &str) -> std::result::Result<Value, Missing> {
        let resource = parse_uri(uri).ok_or(Missing::Resource)?;
        let value = match &resource {
            Resource::Collection(workspace, id) => {
                self.owned(workspace, id, DocumentKind::Collection)
                    .await?
                    .value
            }
            Resource::Request(workspace, id, request) => {
                let collection = self.owned(workspace, id, DocumentKind::Collection).await?;
                find_request(&collection.value["item"], request)
                    .cloned()
                    .ok_or(Missing::Resource)?
            }
            Resource::Environment(workspace, id) => {
                self.owned(workspace, id, DocumentKind::Environment)
                    .await?
                    .value
            }
            Resource::Globals(workspace) => {
                self.documents(workspace, Some(DocumentKind::Globals))
                    .await?
                    .into_iter()
                    .next()
                    .ok_or(Missing::Resource)?
                    .value
            }
            Resource::LastExecution(workspace) => self.last_execution(workspace).await?.value,
        };
        let text = self.redacted(&shareable(&value)).await?;
        Ok(json!({"contents": [{"uri": uri, "mimeType": JSON, "text": text}]}))
    }

    /// A document of a workspace, of the kind asked.
    async fn owned(
        &self,
        workspace: &WorkspaceId,
        id: &str,
        kind: DocumentKind,
    ) -> std::result::Result<Document, Missing> {
        let id = nexo_domain::DocumentId::parse(id).map_err(|_| Missing::Resource)?;
        let document = self.document(&id).await?;
        if &document.workspace_id != workspace || document.kind != kind {
            return Err(Missing::Resource);
        }
        Ok(document)
    }
    async fn last_execution(
        &self,
        workspace: &WorkspaceId,
    ) -> std::result::Result<Document, Missing> {
        let latest = self
            .summaries(workspace, Some(DocumentKind::History))
            .await?
            .into_iter()
            .max_by_key(|summary| summary.updated_at)
            .ok_or(Missing::Resource)?;
        Ok(self.document(&latest.id).await?)
    }

    /// Pretty JSON with every vault value replaced. Without the vault's list the text is not
    /// shared, since nothing could be checked.
    async fn redacted(&self, value: &Value) -> Result<String> {
        let mut text = serde_json::to_string_pretty(value)
            .map_err(|error| Error::Infrastructure(error.to_string()))?;
        for secret in self.secrets.secrets().await? {
            let Ok(secret) = self.secrets.resolve(&secret.name).await else {
                continue;
            };
            if secret.chars().count() < 4 {
                continue;
            }
            let escaped = serde_json::to_string(&secret).unwrap_or_default();
            let escaped = escaped.trim_matches('"').to_string();
            for form in [secret, escaped] {
                if !form.is_empty() {
                    text = text.replace(&form, REDACTED);
                }
            }
        }
        Ok(text)
    }

    /// A workspace by ID or name; the first one holding `collection` when none is given.
    async fn prompt_workspace(
        &self,
        wanted: Option<&str>,
        collection: Option<&str>,
    ) -> std::result::Result<(Workspace, Option<Document>), Missing> {
        let workspaces = self.workspaces().await?;
        let candidates: Vec<Workspace> = match wanted.filter(|w| !w.trim().is_empty()) {
            Some(wanted) => {
                let found = workspaces.into_iter().find(|workspace| {
                    workspace.id.as_str() == wanted || workspace.name.eq_ignore_ascii_case(wanted)
                });
                vec![found.ok_or_else(|| {
                    Missing::Params(format!("There is no workspace named {wanted}"))
                })?]
            }
            None => workspaces,
        };
        let Some(collection) = collection else {
            return candidates
                .into_iter()
                .next()
                .map(|workspace| (workspace, None))
                .ok_or_else(|| Missing::Params("There are no workspaces".into()));
        };
        for workspace in candidates {
            let found = self
                .documents(&workspace.id, Some(DocumentKind::Collection))
                .await?
                .into_iter()
                .find(|document| {
                    document.id.as_str() == collection
                        || document.name.eq_ignore_ascii_case(collection)
                });
            if let Some(found) = found {
                return Ok((workspace, Some(found)));
            }
        }
        Err(Missing::Params(format!(
            "There is no collection named {collection}"
        )))
    }

    /// One prompt with its arguments, as messages that embed the resources it is about.
    pub(crate) async fn mcp_prompt(&self, params: &Value) -> std::result::Result<Value, Missing> {
        let argument = |name: &str| {
            params["arguments"][name]
                .as_str()
                .map(str::trim)
                .filter(|value| !value.is_empty())
        };
        let required = |name: &str| {
            argument(name)
                .ok_or_else(|| Missing::Params(format!("The argument {name} is required")))
        };
        let (description, instruction, resource_uri, value) = match params["name"]
            .as_str()
            .unwrap_or("")
        {
            "write_tests" => {
                let wanted = required("request")?;
                let (workspace, collection) = self
                    .prompt_workspace(argument("workspace"), Some(required("collection")?))
                    .await?;
                let collection = collection.ok_or(Missing::Resource)?;
                let request = find_request(&collection.value["item"], wanted)
                    .cloned()
                    .ok_or_else(|| {
                        Missing::Params(format!(
                            "There is no request named {wanted} in {}",
                            collection.name
                        ))
                    })?;
                let request_id = request["id"].as_str().unwrap_or(wanted).to_string();
                (
                    "Tests for a request",
                    format!(
                        "Write Postman test scripts for the request \"{}\" of the collection \"{}\". Use pm.test and pm.expect to check the status code, the important headers and the shape and values of the JSON body, and save values later requests need with pm.collectionVariables.set. Answer with the JavaScript for the request's Tests tab, with a short comment for each test.",
                        request["name"].as_str().unwrap_or(wanted),
                        collection.name
                    ),
                    uri(
                        &workspace.id,
                        &[
                            "collections",
                            &encode(collection.id.as_str()),
                            "requests",
                            &encode(&request_id),
                        ],
                    ),
                    request,
                )
            }
            "document_collection" => {
                let (workspace, collection) = self
                    .prompt_workspace(argument("workspace"), Some(required("collection")?))
                    .await?;
                let collection = collection.ok_or(Missing::Resource)?;
                (
                    "Documentation for a collection",
                    format!(
                        "Write Markdown documentation for the API collection \"{}\" ({} requests). Start with an overview and how to authenticate, then a section for each folder and request with its method, URL, parameters, headers, body and what it returns. Mention the variables it needs without inventing their values.",
                        collection.name,
                        request_count(&collection.value["item"])
                    ),
                    uri(
                        &workspace.id,
                        &["collections", &encode(collection.id.as_str())],
                    ),
                    collection.value,
                )
            }
            "explain_failure" => {
                let (workspace, _) = self.prompt_workspace(argument("workspace"), None).await?;
                let execution = self
                    .last_execution(&workspace.id)
                    .await
                    .map_err(|missing| match missing {
                        Missing::Resource => Missing::Params(format!(
                            "The workspace {} has no executions yet",
                            workspace.name
                        )),
                        other => other,
                    })?;
                (
                    "Why the last execution failed",
                    format!(
                        "Explain why this request, the last one sent in the workspace \"{}\", failed or returned an unexpected response. Look at the status, headers, body, test results and errors; say what most likely caused it and how to fix the request, its variables or the server. If it actually succeeded, say so.",
                        workspace.name
                    ),
                    uri(&workspace.id, &["history", "latest"]),
                    execution.value,
                )
            }
            _ => return Err(Missing::Params("Unknown prompt".into())),
        };
        let text = self.redacted(&shareable(&value)).await?;
        Ok(json!({
            "description": description,
            "messages": [
                {"role": "user", "content": {"type": "text", "text": instruction}},
                {"role": "user", "content": {"type": "resource", "resource": {
                    "uri": resource_uri, "mimeType": JSON, "text": text
                }}}
            ]
        }))
    }

    pub(crate) fn mcp_prompts() -> Value {
        let workspace = json!({"name": "workspace", "description": "Workspace name or ID; when omitted, the first one that has the collection", "required": false});
        let collection =
            json!({"name": "collection", "description": "Collection name or ID", "required": true});
        json!({"prompts": [
            {"name": "write_tests", "title": "Write tests for a request",
             "description": "Postman test scripts for one request of a collection",
             "arguments": [collection, {"name": "request", "description": "Request name or ID", "required": true}, workspace]},
            {"name": "explain_failure", "title": "Explain the last execution",
             "description": "Why the last request sent failed, and how to fix it",
             "arguments": [{"name": "workspace", "description": "Workspace name or ID; the first one when omitted", "required": false}]},
            {"name": "document_collection", "title": "Document a collection",
             "description": "Markdown documentation of a collection and its requests",
             "arguments": [collection, workspace]}
        ]})
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shared_documents_keep_references_and_hide_credentials() {
        let collection = json!({
            "info": {"name": "Shop"},
            "auth": {"type": "bearer", "bearer": [{"key": "token", "value": "abc123"}]},
            "variable": [
                {"key": "base", "value": "https://api.test"},
                {"key": "apiKey", "value": "k-1"},
                {"key": "hidden", "value": "s", "type": "secret"},
                {"key": "ref", "value": "{{vault:key}}", "type": "secret"},
            ],
            "nexoTransport": {"clientCertificate": "-----BEGIN"},
            "item": [{"id": "r1", "name": "Login", "request": {
                "header": [
                    {"key": "Authorization", "value": "Basic dXNlcjpwYXNz"},
                    {"key": "Accept", "value": "application/json"},
                    {"key": "X-Api-Key", "value": "{{apiKey}}"},
                ],
                "auth": {"type": "hawk", "hawk": [{"key": "key", "value": "hk"}, {"key": "algorithm", "value": "sha256"}]},
            }}],
        });
        let shared = shareable(&collection);
        assert_eq!(shared["auth"]["bearer"][0]["value"], MASKED);
        let variables = &shared["variable"];
        assert_eq!(variables[0]["value"], "https://api.test");
        assert_eq!(variables[1]["value"], MASKED);
        assert_eq!(variables[2]["value"], MASKED);
        assert_eq!(variables[3]["value"], "{{vault:key}}");
        assert!(shared.get("nexoTransport").is_none());
        let request = &shared["item"][0]["request"];
        assert_eq!(request["header"][0]["value"], MASKED);
        assert_eq!(request["header"][1]["value"], "application/json");
        assert_eq!(request["header"][2]["value"], "{{apiKey}}");
        assert_eq!(request["auth"]["hawk"][0]["value"], MASKED);
        assert_eq!(request["auth"]["hawk"][1]["value"], "sha256");
        // History entries keep the interface's shape: `headers` and `values` rows.
        let entry = shareable(
            &json!({"request": {"headers": [{"key": "Cookie", "value": "a=b"}]},
            "environment": {"values": [{"key": "password", "value": "p"}]}}),
        );
        assert_eq!(entry["request"]["headers"][0]["value"], MASKED);
        assert_eq!(entry["environment"]["values"][0]["value"], MASKED);
    }

    #[test]
    fn uris_round_trip_and_unknown_ones_are_refused() {
        let workspace = WorkspaceId::parse("my space").unwrap();
        let address = uri(
            &workspace,
            &["collections", &encode("c/1"), "requests", &encode("r 1")],
        );
        assert_eq!(
            address,
            "nexo://workspaces/my%20space/collections/c%2F1/requests/r%201"
        );
        assert_eq!(
            parse_uri(&address),
            Some(Resource::Request(
                workspace.clone(),
                "c/1".into(),
                "r 1".into()
            ))
        );
        assert_eq!(
            parse_uri("nexo://workspaces/local/history/latest"),
            Some(Resource::LastExecution(
                WorkspaceId::parse("local").unwrap()
            ))
        );
        for unknown in [
            "nexo://workspaces/local",
            "nexo://workspaces/local/runs/1",
            "nexo://workspaces/local/collections/%zz",
            "file:///etc/passwd",
            "nexo://workspaces//globals",
        ] {
            assert_eq!(parse_uri(unknown), None, "{unknown}");
        }
    }

    #[test]
    fn requests_are_found_by_id_or_name_in_folders() {
        let items = json!([
            {"name": "Folder", "item": [{"id": "r2", "name": "Create order", "request": {}}]},
            {"id": "r1", "name": "List orders", "request": {}}
        ]);
        assert_eq!(find_request(&items, "r2").unwrap()["name"], "Create order");
        assert_eq!(find_request(&items, "list ORDERS").unwrap()["id"], "r1");
        assert!(find_request(&items, "Folder").is_none());
        assert_eq!(request_count(&items), 2);
    }
}
