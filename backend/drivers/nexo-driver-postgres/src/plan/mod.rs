//! Execution plans: `EXPLAIN (FORMAT JSON)` and, in the actual mode, `EXPLAIN (ANALYZE,
//! BUFFERS, FORMAT JSON)`, read into the shared form of [`nexo_driver_sdk::explain`].
#[cfg(test)]
mod tests;

use nexo_driver_sdk::{
    DriverError, Result,
    explain::{
        ExplainMode, ExplainParams, PlanNode, PlanRead, PlanReader, Steps, details_of, flags,
        number, text_of,
    },
    statements::ExecuteResult,
};
use serde_json::{Map, Value as Json};

/// The conditions of a node, in the order they apply.
const CONDITIONS: [&str; 6] = [
    "Index Cond",
    "Hash Cond",
    "Merge Cond",
    "Join Filter",
    "Recheck Cond",
    "Filter",
];
/// What the node's own fields hold, not repeated in its details.
const MAPPED: [&str; 22] = [
    "Plans",
    "Node Type",
    "Join Type",
    "Strategy",
    "Operation",
    "Scan Direction",
    "Relation Name",
    "Schema",
    "Index Name",
    "Plan Rows",
    "Total Cost",
    "Actual Rows",
    "Actual Total Time",
    "Actual Loops",
    "Peak Memory Usage",
    "Index Cond",
    "Hash Cond",
    "Merge Cond",
    "Join Filter",
    "Recheck Cond",
    "Filter",
    "Parent Relationship",
];

pub struct PostgresPlans;

impl PlanReader for PostgresPlans {
    fn steps(&self, params: &ExplainParams) -> Result<Steps> {
        let options = match params.mode {
            ExplainMode::Estimated => "FORMAT JSON",
            ExplainMode::Actual => "ANALYZE, BUFFERS, FORMAT JSON",
        };
        let sql = params.sql.trim().trim_end_matches(';').trim_end();
        Ok(Steps {
            plan: format!("EXPLAIN ({options}) {sql}"),
            ..Steps::default()
        })
    }

    fn read(&self, answer: &ExecuteResult, _mode: ExplainMode) -> Result<PlanRead> {
        read(&text_of(&answer.columns, &answer.rows, Some("QUERY PLAN")))
    }
}

/// The plan of what `EXPLAIN (FORMAT JSON)` wrote.
pub fn read(original: &str) -> Result<PlanRead> {
    let unreadable = || DriverError::internal("PostgreSQL answered a plan Nexo cannot read");
    let json: Json = serde_json::from_str(original).map_err(|_| unreadable())?;
    let top = json
        .as_array()
        .and_then(|all| all.first())
        .and_then(Json::as_object)
        .ok_or_else(unreadable)?;
    let mut root = node(
        top.get("Plan")
            .and_then(Json::as_object)
            .ok_or_else(unreadable)?,
    );
    if let Some(planning) = top.get("Planning Time").and_then(number) {
        root.details
            .insert("Planning Time".into(), format!("{planning} ms"));
    }
    Ok(PlanRead {
        nodes: vec![root],
        format: "json",
        original: original.to_owned(),
        total_ms: top.get("Execution Time").and_then(number),
    })
}

fn text(node: &Map<String, Json>, name: &str) -> Option<String> {
    node.get(name).and_then(Json::as_str).map(str::to_owned)
}

/// What a node does, as PostgreSQL's text plans name it: `Hash Left Join`, `HashAggregate`,
/// `Index Scan Backward`, `Update`.
fn operation(node: &Map<String, Json>) -> String {
    let kind = text(node, "Node Type").unwrap_or_else(|| "?".into());
    let join = text(node, "Join Type").filter(|join| join != "Inner");
    match (kind.as_str(), join) {
        ("Aggregate", _) => match text(node, "Strategy").as_deref() {
            Some("Hashed") => "HashAggregate".into(),
            Some("Sorted") => "GroupAggregate".into(),
            Some("Mixed") => "MixedAggregate".into(),
            _ => kind,
        },
        ("ModifyTable", _) => text(node, "Operation").unwrap_or(kind),
        ("Nested Loop", Some(join)) => format!("Nested Loop {join} Join"),
        (other, Some(join)) if other.ends_with(" Join") => {
            format!("{} {join} Join", other.trim_end_matches(" Join"))
        }
        _ if text(node, "Scan Direction").as_deref() == Some("Backward") => {
            format!("{kind} Backward")
        }
        _ => kind,
    }
}

fn node(json: &Map<String, Json>) -> PlanNode {
    let kind = text(json, "Node Type").unwrap_or_default();
    let object = text(json, "Relation Name").map(|relation| match text(json, "Schema") {
        Some(schema) => format!("{schema}.{relation}"),
        None => relation,
    });
    let conditions: Vec<String> = CONDITIONS
        .iter()
        .filter_map(|name| text(json, name))
        .collect();
    let loops = json.get("Actual Loops").and_then(number);
    let memory = json.get("Peak Memory Usage").and_then(number).or_else(|| {
        (text(json, "Sort Space Type").as_deref() == Some("Memory"))
            .then(|| json.get("Sort Space Used").and_then(number))
            .flatten()
    });
    let mut flags = Vec::new();
    if kind == "Seq Scan" {
        flags.push(flags::FULL_SCAN.to_owned());
    }
    let on_disk = text(json, "Sort Space Type").as_deref() == Some("Disk")
        || text(json, "Sort Method").is_some_and(|method| method.contains("external"));
    if on_disk {
        flags.push(flags::DISK_SORT.to_owned());
    }
    PlanNode {
        operation: operation(json),
        object,
        index: text(json, "Index Name"),
        condition: (!conditions.is_empty()).then(|| conditions.join(" AND ")),
        estimated_rows: json.get("Plan Rows").and_then(number),
        estimated_cost: json.get("Total Cost").and_then(number),
        actual_rows: json.get("Actual Rows").and_then(number),
        // PostgreSQL gives the time of one loop.
        actual_ms: json
            .get("Actual Total Time")
            .and_then(number)
            .map(|ms| ms * loops.unwrap_or(1.0)),
        loops,
        memory_kb: memory,
        flags,
        details: details_of(json, &MAPPED),
        children: json
            .get("Plans")
            .and_then(Json::as_array)
            .map(|plans| plans.iter().filter_map(Json::as_object).map(node).collect())
            .unwrap_or_default(),
    }
}
