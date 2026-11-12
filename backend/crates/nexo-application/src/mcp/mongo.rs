//! MongoDB for MCP agents: read-only tools and resources over the connections the person
//! exposed (`mcp: true` in the saved connection; none by default). Only reading operations
//! run, aggregations with `$out` or `$merge` are refused like any read, answers are bounded
//! in documents and size, and the fields the connection hides are masked.
use crate::{Application, database::saved_connection, operations::Operation};
use nexo_domain::{Document, DocumentKind, Error, Result, WorkspaceId};
use serde_json::{Map, Value, json};

/// Documents an agent gets at most from a tool.
pub const MCP_DOCUMENTS: u64 = 100;
/// Documents sampled for a schema.
const MCP_SAMPLE: u64 = 200;
/// Bytes of documents in one answer; later documents are left out.
const MCP_BYTES: usize = 64 * 1024;
const MASK: &str = "[hidden]";

/// The MongoDB tools, for `tools/list`.
pub(super) fn tools() -> Vec<Value> {
    let target = |extra: Value| {
        let mut properties = json!({
            "workspace": {"type": "string", "description": "Workspace id (local by default)"},
            "connection": {"type": "string", "description": "Name of an exposed connection"},
            "database": {"type": "string"},
            "collection": {"type": "string"},
        });
        properties
            .as_object_mut()
            .unwrap_or(&mut Map::new())
            .extend(extra.as_object().cloned().unwrap_or_default());
        json!({"type": "object", "properties": properties, "required": ["connection", "database", "collection"]})
    };
    let limit = json!({"type": "integer", "description": "Documents, at most 100 (20 by default)"});
    vec![
        json!({"name": "mongo_list_connections", "description": "List the MongoDB connections exposed to MCP (names only)",
               "inputSchema": {"type": "object", "properties": {"workspace": {"type": "string"}}}}),
        json!({"name": "mongo_list_databases", "description": "List the databases of an exposed MongoDB connection",
               "inputSchema": {"type": "object", "properties": {"workspace": {"type": "string"}, "connection": {"type": "string"}}, "required": ["connection"]}}),
        json!({"name": "mongo_list_collections", "description": "List the collections of a database",
               "inputSchema": {"type": "object", "properties": {"workspace": {"type": "string"}, "connection": {"type": "string"}, "database": {"type": "string"}}, "required": ["connection", "database"]}}),
        json!({"name": "mongo_find", "description": "Find documents (read-only), in canonical Extended JSON",
               "inputSchema": target(json!({"filter": {"type": "object"}, "projection": {"type": "object"}, "sort": {"type": "object"}, "limit": limit}))}),
        json!({"name": "mongo_aggregate", "description": "Run an aggregation pipeline that only reads ($out and $merge are refused)",
               "inputSchema": target(json!({"pipeline": {"type": "array"}, "limit": limit}))}),
        json!({"name": "mongo_schema", "description": "The schema of a sample of a collection: fields, types, presence and anomalies",
               "inputSchema": target(json!({}))}),
        json!({"name": "mongo_explain", "description": "How the server runs a find (filter, sort) or a pipeline, planned only",
               "inputSchema": target(json!({"filter": {"type": "object"}, "sort": {"type": "object"}, "pipeline": {"type": "array"}}))}),
    ]
}

/// The fields a connection hides from agents, at any depth.
fn mask(value: &mut Value, hidden: &[String]) {
    match value {
        Value::Object(fields) => {
            for (name, field) in fields.iter_mut() {
                if hidden.iter().any(|hide| hide == name) {
                    *field = json!(MASK);
                } else {
                    mask(field, hidden);
                }
            }
        }
        Value::Array(items) => items.iter_mut().for_each(|item| mask(item, hidden)),
        _ => {}
    }
}

/// Documents bounded in size, and whether some were left out.
pub(crate) fn bounded(documents: Vec<Value>, hidden: &[String]) -> Value {
    let total = documents.len();
    let (mut kept, mut bytes) = (Vec::new(), 0);
    for mut document in documents {
        mask(&mut document, hidden);
        bytes += document.to_string().len();
        if bytes > MCP_BYTES && !kept.is_empty() {
            break;
        }
        kept.push(document);
    }
    json!({"documents": kept, "truncated": kept.len() < total})
}

fn text(arguments: &Value, key: &str) -> Result<String> {
    arguments[key]
        .as_str()
        .filter(|value| !value.trim().is_empty())
        .map(String::from)
        .ok_or_else(|| Error::Validation(format!("arguments.{key} is required")))
}

/// Whether a saved connection is exposed to MCP.
pub(super) fn exposed(document: &Document) -> bool {
    document.kind == DocumentKind::Connection && document.value["mcp"] == true
}

impl Application {
    /// The exposed connections of a workspace.
    pub(super) async fn mcp_connections(&self, workspace: &WorkspaceId) -> Result<Vec<Document>> {
        Ok(self
            .workspaces
            .documents(workspace, Some(DocumentKind::Connection))
            .await?
            .into_iter()
            .filter(exposed)
            .collect())
    }
    /// An exposed connection by its name; one that is not exposed is not found either.
    pub(super) async fn mcp_connection(
        &self,
        workspace: &WorkspaceId,
        name: &str,
    ) -> Result<Document> {
        self.mcp_connections(workspace)
            .await?
            .into_iter()
            .find(|document| document.name == name || document.id.as_str() == name)
            .ok_or_else(|| {
                Error::Validation(format!(
                    "No MongoDB connection named {name} is exposed to MCP"
                ))
            })
    }

    /// The databases of an exposed connection, each with its collections.
    pub(super) async fn mcp_mongo_overview(
        &self,
        workspace: &WorkspaceId,
        connection: &str,
    ) -> Result<Value> {
        let arguments = json!({"workspace": workspace.as_str(), "connection": connection});
        let databases = self
            .mongo_tool_run("mongo_list_databases", &arguments)
            .await?;
        let mut overview = Vec::new();
        for database in databases["databases"]
            .as_array()
            .into_iter()
            .flatten()
            .take(50)
        {
            let name = database["name"].as_str().unwrap_or_default();
            let mut arguments = arguments.clone();
            arguments["database"] = json!(name);
            let collections = self
                .mongo_tool_run("mongo_list_collections", &arguments)
                .await?;
            let names: Vec<Value> = collections["collections"]
                .as_array()
                .into_iter()
                .flatten()
                .map(|collection| collection["name"].clone())
                .collect();
            overview.push(json!({"database": name, "collections": names}));
        }
        Ok(json!({"connection": connection, "databases": overview}))
    }
    /// Runs a MongoDB tool; `None` when the name is not one of them.
    pub(super) async fn mongo_tool(&self, name: &str, arguments: &Value) -> Option<Result<Value>> {
        if !name.starts_with("mongo_") {
            return None;
        }
        Some(self.mongo_tool_run(name, arguments).await)
    }

    async fn mongo_tool_run(&self, name: &str, arguments: &Value) -> Result<Value> {
        let workspace = WorkspaceId::parse(arguments["workspace"].as_str().unwrap_or("local"))?;
        if name == "mongo_list_connections" {
            let names: Vec<String> = self
                .mcp_connections(&workspace)
                .await?
                .into_iter()
                .map(|document| document.name)
                .collect();
            return Ok(json!({ "connections": names }));
        }
        let saved = self
            .mcp_connection(&workspace, &text(arguments, "connection")?)
            .await?;
        let hidden: Vec<String> = saved.value["mcpHidden"]
            .as_array()
            .map(|names| {
                names
                    .iter()
                    .filter_map(Value::as_str)
                    .map(String::from)
                    .collect()
            })
            .unwrap_or_default();
        let mut payload = json!({
            "workspace": workspace.as_str(),
            "connection": saved_connection(&saved.value, &Map::new()),
        });
        if name == "mongo_list_databases" {
            return self.execute(Operation::MongoDatabases, payload).await;
        }
        payload["database"] = json!(text(arguments, "database")?);
        if name == "mongo_list_collections" {
            return self.execute(Operation::MongoCollections, payload).await;
        }
        payload["collection"] = json!(text(arguments, "collection")?);
        let id = || json!(format!("mcp-{}", uuid::Uuid::new_v4()));
        let limit = arguments["limit"]
            .as_u64()
            .unwrap_or(20)
            .clamp(1, MCP_DOCUMENTS);
        let copy = |payload: &mut Value, keys: &[&str]| {
            for key in keys {
                if let Some(value) = arguments.get(*key).filter(|value| !value.is_null()) {
                    payload[*key] = value.clone();
                }
            }
        };
        match name {
            "mongo_find" => {
                copy(&mut payload, &["filter", "projection", "sort"]);
                payload["id"] = id();
                payload["limit"] = json!(limit);
                payload["pageSize"] = json!(limit);
                let page = self.execute(Operation::MongoFind, payload).await?;
                let documents = page["documents"].as_array().cloned().unwrap_or_default();
                Ok(bounded(documents, &hidden))
            }
            "mongo_aggregate" => {
                let mut pipeline = arguments["pipeline"].as_array().cloned().ok_or_else(|| {
                    Error::Validation("arguments.pipeline is an array of stages".into())
                })?;
                pipeline.push(json!({ "$limit": limit }));
                payload["pipeline"] = json!(pipeline);
                payload["id"] = id();
                payload["pageSize"] = json!(limit);
                let page = self.execute(Operation::MongoAggregate, payload).await?;
                let documents = page["documents"].as_array().cloned().unwrap_or_default();
                Ok(bounded(documents, &hidden))
            }
            "mongo_schema" => {
                payload["id"] = id();
                payload["size"] = json!(MCP_SAMPLE);
                let mut schema = self.execute(Operation::MongoSchema, payload).await?;
                // Frequent values are data: masked like documents.
                for field in schema["fields"].as_array_mut().into_iter().flatten() {
                    let path = field["path"].as_str().unwrap_or_default().to_string();
                    if hidden
                        .iter()
                        .any(|hide| path.split('.').any(|part| part == hide))
                    {
                        field["values"] = json!([]);
                        if let Some(types) = field["types"].as_array_mut() {
                            for summary in types {
                                if let Some(summary) = summary.as_object_mut() {
                                    summary.remove("min");
                                    summary.remove("max");
                                }
                            }
                        }
                    }
                }
                Ok(schema)
            }
            "mongo_explain" => {
                copy(&mut payload, &["filter", "sort", "pipeline"]);
                payload["id"] = id();
                self.execute(Operation::MongoExplain, payload).await
            }
            _ => Err(Error::Validation(format!("Unknown MongoDB tool {name}"))),
        }
    }
}
