//! SQL databases for MCP agents (DB-32): read-only tools and resources over the connections
//! of the database modules the person exposed (`mcp: true`; none by default). Each call opens
//! a session of its own only to read and closes it; a statement runs only if it reads, answers
//! are bounded in rows and size, and the columns the connection hides (`mcpHidden`) come as
//! `[hidden]`, also under another name.
mod hidden;
mod tools;
mod walk;

pub(super) use tools::tools;

use crate::{Application, datasource::classify_sql, operations::Operation};
use hidden::Hidden;
use nexo_domain::{Document, DocumentKind, Error, Result, WorkspaceId, sql::StatementKind};
use serde_json::{Map, Value, json};

/// Rows an agent gets at most from a query.
pub const MCP_ROWS: u64 = 100;
/// Bytes of rows in one answer; later rows are left out.
const MCP_BYTES: usize = 64 * 1024;

fn text(arguments: &Value, key: &str) -> Result<String> {
    arguments[key]
        .as_str()
        .filter(|value| !value.trim().is_empty())
        .map(String::from)
        .ok_or_else(|| Error::Validation(format!("arguments.{key} is required")))
}
fn path(arguments: &Value) -> Vec<String> {
    arguments["path"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(String::from)
        .collect()
}

/// Whether a saved connection of a database module is exposed to MCP.
pub(super) fn exposed_sql(document: &Document) -> bool {
    super::mongo::exposed(document)
        && document.value["driver"]
            .as_str()
            .is_some_and(|driver| driver != "mongodb")
}

/// Rows as objects by column, bounded in size, and whether some were left out.
fn bounded(rows: Vec<Value>, total: usize, cut: bool) -> Value {
    let (mut kept, mut bytes) = (Vec::new(), 0);
    for row in rows {
        bytes += row.to_string().len();
        if bytes > MCP_BYTES && !kept.is_empty() {
            break;
        }
        kept.push(row);
    }
    let truncated = cut || kept.len() < total;
    json!({"rows": kept, "truncated": truncated})
}

impl Application {
    /// The exposed SQL connections of a workspace.
    pub(super) async fn mcp_sql_connections(
        &self,
        workspace: &WorkspaceId,
    ) -> Result<Vec<Document>> {
        Ok(self
            .workspaces
            .documents(workspace, Some(DocumentKind::Connection))
            .await?
            .into_iter()
            .filter(exposed_sql)
            .collect())
    }

    /// Runs an SQL tool; `None` when the name is not one of them.
    pub(super) async fn sql_tool(&self, name: &str, arguments: &Value) -> Option<Result<Value>> {
        if !name.starts_with("sql_") {
            return None;
        }
        Some(self.sql_tool_run(name, arguments).await)
    }

    pub(super) async fn sql_tool_run(&self, name: &str, arguments: &Value) -> Result<Value> {
        let workspace = WorkspaceId::parse(arguments["workspace"].as_str().unwrap_or("local"))?;
        if name == "sql_list_connections" {
            let connections: Vec<Value> = self
                .mcp_sql_connections(&workspace)
                .await?
                .into_iter()
                .map(|document| json!({"name": document.name, "driver": document.value["driver"]}))
                .collect();
            return Ok(json!({ "connections": connections }));
        }
        let wanted = text(arguments, "connection")?;
        let saved = self
            .mcp_sql_connections(&workspace)
            .await?
            .into_iter()
            .find(|document| document.name == wanted || document.id.as_str() == wanted)
            .ok_or_else(|| {
                Error::Validation(format!(
                    "No SQL connection named {wanted} is exposed to MCP"
                ))
            })?;
        if !matches!(
            name,
            "sql_list_tables" | "sql_describe_table" | "sql_query" | "sql_explain"
        ) {
            return Err(Error::Validation(format!("Unknown SQL tool {name}")));
        }
        let session = format!("mcp-{}", uuid::Uuid::new_v4().simple());
        self.datasource(
            Operation::DbConnect,
            json!({"workspace": workspace.as_str(), "connectionId": saved.id.as_str(),
                   "session": session, "readOnly": true}),
        )
        .await?;
        let outcome = self
            .sql_tool_on(name, arguments, &workspace, &saved, &session)
            .await;
        let _ = self
            .datasource(Operation::DbDisconnect, json!({"session": session}))
            .await;
        outcome
    }

    async fn sql_tool_on(
        &self,
        name: &str,
        arguments: &Value,
        workspace: &WorkspaceId,
        saved: &Document,
        session: &str,
    ) -> Result<Value> {
        match name {
            "sql_list_tables" => {
                let tables = self.sql_walk(session, path(arguments)).await?;
                Ok(
                    json!({"connection": saved.name, "driver": saved.value["driver"], "tables": tables}),
                )
            }
            "sql_describe_table" => {
                let path = path(arguments);
                if path.is_empty() {
                    return Err(Error::Validation("arguments.path is required".into()));
                }
                self.datasource(
                    Operation::DbDescribe,
                    json!({"session": session, "path": path}),
                )
                .await
            }
            "sql_explain" => {
                let sql = text(arguments, "sql")?;
                self.datasource(
                    Operation::DbExplain,
                    json!({"session": session, "statement": format!("{session}-plan"), "sql": sql,
                           "mode": "estimated"}),
                )
                .await
            }
            _ => self.sql_query(arguments, workspace, saved, session).await,
        }
    }

    async fn sql_query(
        &self,
        arguments: &Value,
        workspace: &WorkspaceId,
        saved: &Document,
        session: &str,
    ) -> Result<Value> {
        let sql = text(arguments, "sql")?;
        let driver = saved.value["driver"].as_str().unwrap_or_default();
        let kind = classify_sql(&sql, driver);
        if kind != StatementKind::Read {
            return Err(Error::Validation(
                "MCP agents can only read: this statement is not a query".into(),
            ));
        }
        let limit = arguments["limit"].as_u64().unwrap_or(20).clamp(1, MCP_ROWS);
        let answer = self
            .datasource(
                Operation::DbExecute,
                json!({"session": session, "statement": format!("{session}-query"), "sql": sql,
                       "params": arguments["params"].as_array().cloned().unwrap_or_default(),
                       "pageRows": limit, "maxRows": limit + 1}),
            )
            .await?;
        if let Some(cursor) = answer["cursor"].as_str() {
            let _ = self
                .datasource(
                    Operation::DbClose,
                    json!({"session": session, "cursor": cursor}),
                )
                .await;
        }
        let columns = answer["columns"].as_array().cloned().unwrap_or_default();
        let hidden = Hidden::read(&saved.value["mcpHidden"]).columns(&columns, &sql);
        let names: Vec<String> = columns
            .iter()
            .enumerate()
            .map(|(at, column)| {
                let name = column["name"].as_str().unwrap_or_default();
                let repeated = columns[..at]
                    .iter()
                    .any(|other| other["name"] == column["name"]);
                if repeated {
                    format!("{name}_{}", at + 1)
                } else {
                    name.to_owned()
                }
            })
            .collect();
        let rows: Vec<Value> = answer["rows"]
            .as_array()
            .into_iter()
            .flatten()
            .take(limit as usize)
            .map(|row| {
                let mut object = Map::new();
                for (at, name) in names.iter().enumerate() {
                    let value = if hidden[at] {
                        json!(hidden::MASK)
                    } else {
                        row[at].clone()
                    };
                    object.insert(name.clone(), value);
                }
                Value::Object(object)
            })
            .collect();
        let cut = answer["cursor"].is_string()
            || answer["rows"]
                .as_array()
                .is_some_and(|all| all.len() as u64 > limit);
        let total = rows.len();
        let rows = self.mask_for_agents(workspace, rows).await?;
        let mut bounded = bounded(rows, total, cut);
        bounded["columns"] = json!(names);
        Ok(bounded)
    }
}
