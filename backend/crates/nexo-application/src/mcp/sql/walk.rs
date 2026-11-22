//! The tables and views of an exposed SQL connection, walked through its tree, and the
//! resources built on them.
use crate::{Application, operations::Operation};
use nexo_domain::{Error, Result, WorkspaceId};
use serde_json::{Value, json};

/// Calls of the tree a listing of tables makes at most, and the objects it gives.
const WALK_CALLS: usize = 100;
const WALK_OBJECTS: usize = 500;

impl Application {
    /// The tables and views under a path of the tree, walked through its databases, schemas
    /// and folders, with the path of each.
    pub(in crate::mcp) async fn sql_walk(
        &self,
        session: &str,
        start: Vec<String>,
    ) -> Result<Vec<Value>> {
        let mut pending = vec![start];
        let (mut calls, mut found) = (0, Vec::new());
        while let Some(path) = pending.pop() {
            if calls >= WALK_CALLS || found.len() >= WALK_OBJECTS {
                break;
            }
            calls += 1;
            let tree = self
                .datasource(Operation::DbTree, json!({"session": session, "path": path}))
                .await?;
            for node in tree["nodes"].as_array().into_iter().flatten() {
                if node["system"] == true {
                    continue;
                }
                let kind = node["kind"].as_str().unwrap_or_default();
                let mut child = path.clone();
                child.push(node["name"].as_str().unwrap_or_default().to_owned());
                if kind.contains("table") || kind.contains("view") {
                    found.push(json!({"path": child, "kind": kind}));
                } else if node["hasChildren"] == true
                    && matches!(kind, "database" | "schema" | "catalog" | "folder")
                {
                    pending.insert(0, child);
                }
            }
        }
        Ok(found)
    }

    /// The overview of an exposed SQL connection, for its resource.
    pub(in crate::mcp) async fn mcp_sql_overview(
        &self,
        workspace: &WorkspaceId,
        connection: &str,
    ) -> Result<Value> {
        let arguments = json!({"workspace": workspace.as_str(), "connection": connection});
        self.sql_tool_run("sql_list_tables", &arguments).await
    }

    /// The description of a table of an exposed SQL connection by its schema and name; any
    /// schema names the table of an engine without them.
    pub(in crate::mcp) async fn mcp_sql_table(
        &self,
        workspace: &WorkspaceId,
        connection: &str,
        schema: &str,
        table: &str,
    ) -> Result<Value> {
        let overview = self.mcp_sql_overview(workspace, connection).await?;
        let parts = |path: &Value| -> Vec<String> {
            path.as_array()
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
                .map(String::from)
                .collect()
        };
        let candidates: Vec<Vec<String>> = overview["tables"]
            .as_array()
            .into_iter()
            .flatten()
            .map(|found| parts(&found["path"]))
            .filter(|path| path.last().map(String::as_str) == Some(table))
            .collect();
        // The one in that schema; an engine without schemas (SQLite) has only one.
        let path = match candidates
            .iter()
            .find(|path| path.iter().any(|part| part == schema))
        {
            Some(path) => path.clone(),
            None if candidates.len() == 1 => candidates[0].clone(),
            None => return Err(Error::NotFound),
        };
        let arguments =
            json!({"workspace": workspace.as_str(), "connection": connection, "path": path});
        self.sql_tool_run("sql_describe_table", &arguments).await
    }
}
