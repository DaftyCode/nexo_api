//! What the SQL tools take, for `tools/list`.
use serde_json::{Value, json};

/// The SQL tools, for `tools/list`.
pub(in crate::mcp) fn tools() -> Vec<Value> {
    let base = |extra: Value, required: &[&str]| {
        let mut properties = json!({
            "workspace": {"type": "string", "description": "Workspace id (local by default)"},
            "connection": {"type": "string", "description": "Name of an exposed connection"},
        });
        if let (Some(all), Some(more)) = (properties.as_object_mut(), extra.as_object()) {
            all.extend(more.clone());
        }
        json!({"type": "object", "properties": properties, "required": required})
    };
    let path = json!({"type": "array", "items": {"type": "string"},
                      "description": "The path of the object in the tree, as sql_list_tables gives it"});
    vec![
        json!({"name": "sql_list_connections", "description": "List the SQL connections exposed to MCP (names and engines only)",
               "inputSchema": {"type": "object", "properties": {"workspace": {"type": "string"}}}}),
        json!({"name": "sql_list_tables", "description": "List the schemas, tables and views of an exposed SQL connection, with their paths",
               "inputSchema": base(json!({"path": path.clone()}), &["connection"])}),
        json!({"name": "sql_describe_table", "description": "Describe a table or a view: columns, keys, indexes",
               "inputSchema": base(json!({"path": path}), &["connection", "path"])}),
        json!({"name": "sql_query", "description": "Run a query that only reads (anything else is refused), 100 rows at most",
               "inputSchema": base(json!({"sql": {"type": "string"}, "params": {"type": "array"},
                   "limit": {"type": "integer", "description": "Rows, at most 100 (20 by default)"}}), &["connection", "sql"])}),
        json!({"name": "sql_explain", "description": "The estimated plan of a statement, without running it",
               "inputSchema": base(json!({"sql": {"type": "string"}}), &["connection", "sql"])}),
    ]
}
