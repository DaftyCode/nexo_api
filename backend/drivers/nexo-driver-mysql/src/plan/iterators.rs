//! MySQL's iterator format (`explain_json_format_version = 2`): one node per iterator, with
//! its own words for what it does, its estimates and, from `EXPLAIN ANALYZE`, its measures.
use nexo_driver_sdk::explain::{PlanNode, details_of, flags, number};
use serde_json::{Map, Value as Json};

const MAPPED: [&str; 13] = [
    "inputs",
    "operation",
    "table_name",
    "index_name",
    "condition",
    "estimated_rows",
    "estimated_total_cost",
    "actual_rows",
    "actual_loops",
    "actual_last_row_ms",
    "query",
    "covering",
    "used_columns",
];

/// The top node and the milliseconds of the whole query (its last row).
pub fn read(top: &Map<String, Json>) -> (Vec<PlanNode>, Option<f64>) {
    let root = node(top);
    let total = root.actual_ms;
    (vec![root], total)
}

fn node(json: &Map<String, Json>) -> PlanNode {
    let text = |name: &str| json.get(name).and_then(Json::as_str).map(str::to_owned);
    let loops = json.get("actual_loops").and_then(number);
    let mut flags = Vec::new();
    match text("access_type").as_deref() {
        Some("table") => flags.push(flags::FULL_SCAN.to_owned()),
        Some("temp_table_aggregate" | "materialize" | "temp_table") => {
            flags.push(flags::TEMPORARY.to_owned())
        }
        _ => {}
    }
    PlanNode {
        operation: text("operation").unwrap_or_else(|| "?".into()),
        object: text("table_name"),
        index: text("index_name"),
        condition: text("condition").or_else(|| text("lookup_condition")),
        estimated_rows: json.get("estimated_rows").and_then(number),
        estimated_cost: json.get("estimated_total_cost").and_then(number),
        actual_rows: json.get("actual_rows").and_then(number),
        // The time to the last row of one loop.
        actual_ms: json
            .get("actual_last_row_ms")
            .and_then(number)
            .map(|ms| ms * loops.unwrap_or(1.0)),
        loops,
        memory_kb: None,
        flags,
        details: details_of(json, &MAPPED),
        children: json
            .get("inputs")
            .and_then(Json::as_array)
            .map(|inputs| {
                inputs
                    .iter()
                    .filter_map(Json::as_object)
                    .map(node)
                    .collect()
            })
            .unwrap_or_default(),
    }
}
