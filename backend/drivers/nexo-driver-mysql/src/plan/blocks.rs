//! The block format of MySQL (version 1) and MariaDB: a `query_block` whose operations
//! (`ordering_operation`, `nested_loop`, `filesort`, `temporary_table`…) hold the tables
//! they read. Every object below a block is a node, except the ones that only describe one.
use nexo_driver_sdk::explain::{PlanNode, details_of, flags, number};
use serde_json::{Map, Value as Json};

/// Objects that describe their node instead of being one.
const FACTS: [&str; 4] = [
    "cost_info",
    "r_engine_stats",
    "query_optimization",
    "buffer_size",
];
const MAPPED: [&str; 12] = [
    "table_name",
    "access_type",
    "key",
    "attached_condition",
    "rows_examined_per_scan",
    "rows",
    "cost",
    "r_rows",
    "r_loops",
    "r_total_time_ms",
    "select_id",
    "sort_key",
];

/// The top block and the milliseconds the whole statement took (MariaDB's `ANALYZE`).
pub fn read(top: &Map<String, Json>) -> (Vec<PlanNode>, Option<f64>) {
    let total = top
        .get("query_block")
        .and_then(|block| block.get("r_total_time_ms"))
        .and_then(number);
    let nodes = top
        .iter()
        .filter(|(key, _)| !FACTS.contains(&key.as_str()))
        .flat_map(|(key, value)| nodes(key, value))
        .collect();
    (nodes, total)
}

/// The nodes `value` holds under `key`: one for an object, one per object of a list.
fn nodes(key: &str, value: &Json) -> Vec<PlanNode> {
    match value {
        Json::Object(object) => vec![node(key, object)],
        Json::Array(items) => {
            let objects: Vec<&Map<String, Json>> =
                items.iter().filter_map(Json::as_object).collect();
            // A list of wrappers (`[{"table": …}, {"read_sorted_file": …}]`) is the list of
            // what they wrap.
            objects
                .into_iter()
                .flat_map(|object| {
                    if object.len() == 1 {
                        let (inner, value) = object.iter().next().unwrap();
                        if value.is_object() {
                            return nodes(inner, value);
                        }
                    }
                    vec![node(key, object)]
                })
                .collect()
        }
        _ => Vec::new(),
    }
}

/// What a table's access type means.
fn access(kind: &str) -> String {
    match kind {
        "ALL" => "Full table scan".into(),
        "index" => "Full index scan".into(),
        "range" => "Index range scan".into(),
        "ref" | "ref_or_null" => "Index lookup".into(),
        "eq_ref" => "Unique index lookup".into(),
        "const" | "system" => "Constant row".into(),
        "index_merge" => "Index merge".into(),
        other => format!("Access {other}"),
    }
}

/// `ordering_operation` → `Ordering operation`.
fn label(key: &str) -> String {
    match key {
        "query_block" => "Query block".into(),
        "filesort" | "ordering_operation" => "Sort".into(),
        "grouping_operation" => "Group".into(),
        "duplicates_removal" => "Distinct".into(),
        other => {
            let words = other.replace(['_', '-'], " ");
            let mut letters = words.chars();
            letters
                .next()
                .map(|first| first.to_uppercase().chain(letters).collect())
                .unwrap_or_default()
        }
    }
}

fn node(key: &str, json: &Map<String, Json>) -> PlanNode {
    let text = |name: &str| json.get(name).and_then(Json::as_str).map(str::to_owned);
    let cost = |name: &str| {
        json.get("cost_info")
            .and_then(|info| info.get(name))
            .and_then(number)
    };
    let table = key == "table";
    let mut operation = if table {
        access(text("access_type").as_deref().unwrap_or("?"))
    } else {
        label(key)
    };
    if table && json.contains_key("update") {
        operation = format!("Update: {operation}");
    } else if table && json.contains_key("delete") {
        operation = format!("Delete: {operation}");
    } else if key == "query_block"
        && let Some(id) = json.get("select_id").and_then(number)
    {
        operation = format!("Query block #{id}");
    }
    let mut flags = Vec::new();
    if text("access_type").as_deref() == Some("ALL") {
        flags.push(flags::FULL_SCAN.to_owned());
    }
    if key == "temporary_table" || json.get("using_temporary_table") == Some(&Json::Bool(true)) {
        flags.push(flags::TEMPORARY.to_owned());
    }
    // MariaDB counts the merge passes of a sort that did not fit in its buffer.
    if json.get("r_sort_passes").and_then(number).unwrap_or(0.0) > 0.0 {
        flags.push(flags::DISK_SORT.to_owned());
    }
    let estimated_cost = json
        .get("cost")
        .and_then(number)
        .or_else(|| cost("query_cost"))
        .or_else(|| match (cost("read_cost"), cost("eval_cost")) {
            (Some(read), Some(eval)) => Some(read + eval),
            _ => cost("sort_cost"),
        });
    let actual_ms = json.get("r_total_time_ms").and_then(number).or_else(|| {
        let table = json.get("r_table_time_ms").and_then(number)?;
        Some(table + json.get("r_other_time_ms").and_then(number).unwrap_or(0.0))
    });
    let mut details = details_of(json, &MAPPED);
    if let Some(sort) = text("sort_key") {
        details.insert("sort_key".into(), sort);
    }
    PlanNode {
        operation,
        object: text("table_name"),
        index: text("key"),
        condition: text("attached_condition").or_else(|| text("index_condition")),
        estimated_rows: json
            .get("rows_examined_per_scan")
            .or_else(|| json.get("rows"))
            .and_then(number),
        estimated_cost,
        actual_rows: json.get("r_rows").and_then(number),
        actual_ms,
        loops: json.get("r_loops").and_then(number),
        memory_kb: None,
        flags,
        details,
        children: json
            .iter()
            .filter(|(name, _)| !FACTS.contains(&name.as_str()))
            .flat_map(|(name, value)| nodes(name, value))
            .collect(),
    }
}
