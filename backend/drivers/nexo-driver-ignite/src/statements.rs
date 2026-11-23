//! What the node said about itself, and the plan of a statement (`EXPLAIN PLAN FOR`, which
//! Ignite answers as text).
use crate::connection::Connection;
use nexo_driver_sdk::{
    Result, Value,
    explain::{ExplainMode, Plan, PlanNode},
    protocol::{ConnectParams, ServerInfo},
};

pub fn server(connection: &Connection, params: &ConnectParams) -> ServerInfo {
    let node = &connection.client.node;
    ServerInfo {
        server_version: node.version.clone(),
        product: Some(format!("Apache Ignite · {} · {}", node.cluster, node.name)),
        database: connection.schema.clone(),
        user: params.user.clone().filter(|user| !user.is_empty()),
        tls: connection.client.tls,
    }
}

/// The plan as Ignite writes it; its first line names the top node in the viewer.
pub fn plan(original: String) -> Plan {
    let nodes = original
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .map(|line| PlanNode {
            operation: line.trim_end_matches(':').to_owned(),
            ..PlanNode::default()
        })
        .into_iter()
        .collect();
    Plan {
        mode: ExplainMode::Estimated,
        nodes,
        format: "text".into(),
        original,
        total_ms: None,
        rolled_back: false,
    }
}

pub async fn explain(connection: &Connection, sql: &str) -> Result<Plan> {
    let sql = format!("EXPLAIN PLAN FOR {}", sql.trim().trim_end_matches(';'));
    let rows = connection.query(&sql, &[]).await?;
    let original = rows
        .iter()
        .filter_map(|row| match row.first() {
            Some(Value::Text(text)) => Some(text.clone()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("\n");
    Ok(plan(original))
}
