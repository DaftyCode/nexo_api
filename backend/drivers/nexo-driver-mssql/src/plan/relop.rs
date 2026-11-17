//! A showplan read into nodes: a node per statement, holding the tree of its operators
//! (`RelOp`), each with its object, index, predicate, estimates and, in the actual mode, the
//! counters of its threads summed.
use super::xml::Element;
use nexo_driver_sdk::explain::{PlanNode, flags};

/// Attributes of a `RelOp` its fields already hold.
const MAPPED: [&str; 5] = [
    "NodeId",
    "PhysicalOp",
    "LogicalOp",
    "EstimateRows",
    "EstimatedTotalSubtreeCost",
];
/// Operators that read a whole table.
const FULL_SCANS: [&str; 2] = ["Table Scan", "Clustered Index Scan"];

fn number(element: &Element, name: &str) -> Option<f64> {
    element.attribute(name)?.parse().ok()
}
/// `[shop]` → `shop`.
fn bare(name: &str) -> &str {
    name.trim_start_matches('[').trim_end_matches(']')
}

/// The nodes of every statement of a showplan, and the milliseconds the batch took.
pub fn statements(plan: &Element) -> (Vec<PlanNode>, Option<f64>) {
    let mut found = Vec::new();
    plan.descendants("RelOp", &mut found);
    let mut total = None;
    let nodes = found
        .into_iter()
        .filter(|element| element.name == "StmtSimple" || element.name == "StmtCursor")
        .map(|statement| {
            let query = statement.child("QueryPlan");
            let elapsed = query
                .and_then(|query| query.child("QueryTimeStats"))
                .and_then(|stats| number(stats, "ElapsedTime"));
            if let Some(ms) = elapsed {
                *total.get_or_insert(0.0) += ms;
            }
            let mut node = PlanNode {
                operation: statement
                    .attribute("StatementType")
                    .unwrap_or("STATEMENT")
                    .to_owned(),
                estimated_rows: number(statement, "StatementEstRows"),
                estimated_cost: number(statement, "StatementSubTreeCost"),
                actual_ms: elapsed,
                memory_kb: query
                    .and_then(|query| query.child("MemoryGrantInfo"))
                    .and_then(|grant| number(grant, "MaxUsedMemory"))
                    .filter(|used| *used > 0.0),
                children: query
                    .map(|query| {
                        query
                            .children
                            .iter()
                            .filter(|child| child.name == "RelOp")
                            .map(operator)
                            .collect()
                    })
                    .unwrap_or_default(),
                ..PlanNode::default()
            };
            if let Some(text) = statement.attribute("StatementText") {
                node.details.insert("StatementText".into(), text.to_owned());
            }
            if let Some(level) = statement.attribute("StatementOptmLevel") {
                node.details
                    .insert("StatementOptmLevel".into(), level.to_owned());
            }
            node
        })
        .collect();
    (nodes, total)
}

/// `n < @1`, from the ranges of a seek.
fn seek(range: &Element) -> Option<String> {
    let column = range
        .child("RangeColumns")?
        .child("ColumnReference")?
        .attribute("Column")?;
    let sign = match range.attribute("ScanType")? {
        "EQ" => "=",
        "LT" => "<",
        "LE" => "<=",
        "GT" => ">",
        "GE" => ">=",
        "IS" => "IS",
        other => other,
    };
    let value = range
        .child("RangeExpressions")?
        .child("ScalarOperator")?
        .attribute("ScalarString")?;
    Some(format!("{column} {sign} {value}"))
}

fn operator(relop: &Element) -> PlanNode {
    let physical = relop.attribute("PhysicalOp").unwrap_or("?");
    let logical = relop.attribute("LogicalOp").unwrap_or(physical);
    // What belongs to this operator: its elements down to the next operators, its children.
    let mut found = Vec::new();
    relop.descendants("RelOp", &mut found);
    let (children, own): (Vec<&Element>, Vec<&Element>) = found
        .into_iter()
        .partition(|element| element.name == "RelOp");
    let object = own.iter().find(|element| element.name == "Object");
    let predicate = own
        .iter()
        .find(|element| element.name == "Predicate")
        .and_then(|predicate| predicate.child("ScalarOperator"))
        .and_then(|scalar| scalar.attribute("ScalarString"))
        .map(str::to_owned);
    let seeks: Vec<String> = own
        .iter()
        .filter(|element| ["Prefix", "StartRange", "EndRange"].contains(&element.name.as_str()))
        .filter_map(|range| seek(range))
        .collect();
    let counters: Vec<&&Element> = own
        .iter()
        .filter(|element| element.name == "RunTimeCountersPerThread")
        .collect();
    let sum = |name: &str| -> Option<f64> {
        let values: Vec<f64> = counters.iter().filter_map(|c| number(c, name)).collect();
        (!values.is_empty()).then(|| values.iter().sum())
    };
    let executions = sum("ActualExecutions");
    let mut flags = Vec::new();
    if FULL_SCANS.contains(&physical) {
        flags.push(flags::FULL_SCAN.to_owned());
    }
    if own.iter().any(|element| element.name == "SpillToTempDb") {
        flags.push(flags::DISK_SORT.to_owned());
    }
    if logical.ends_with("Spool") {
        flags.push(flags::TEMPORARY.to_owned());
    }
    let mut details: std::collections::BTreeMap<String, String> = relop
        .attributes
        .iter()
        .filter(|(name, _)| !MAPPED.contains(&name.as_str()))
        .map(|(name, value)| (name.clone(), value.clone()))
        .collect();
    if let Some(alias) = object.and_then(|object| object.attribute("Alias")) {
        details.insert("Alias".into(), bare(alias).to_owned());
    }
    for name in ["ActualLogicalReads", "ActualPhysicalReads", "ActualCPUms"] {
        if let Some(value) = sum(name) {
            details.insert(name.into(), value.to_string());
        }
    }
    PlanNode {
        operation: if logical == physical {
            physical.to_owned()
        } else {
            format!("{physical} ({logical})")
        },
        object: object.and_then(|object| {
            let table = bare(object.attribute("Table")?);
            Some(match object.attribute("Schema") {
                Some(schema) => format!("{}.{table}", bare(schema)),
                None => table.to_owned(),
            })
        }),
        index: object
            .and_then(|object| object.attribute("Index"))
            .map(|index| bare(index).to_owned()),
        condition: match (seeks.is_empty(), predicate) {
            (false, Some(predicate)) => Some(format!("{} AND {predicate}", seeks.join(" AND "))),
            (false, None) => Some(seeks.join(" AND ")),
            (true, predicate) => predicate,
        },
        estimated_rows: number(relop, "EstimateRows"),
        estimated_cost: number(relop, "EstimatedTotalSubtreeCost"),
        // SQL Server counts the rows of every execution; the estimate is of one.
        actual_rows: sum("ActualRows").map(|rows| rows / executions.unwrap_or(1.0).max(1.0)),
        actual_ms: counters
            .iter()
            .filter_map(|counter| number(counter, "ActualElapsedms"))
            .reduce(f64::max),
        loops: executions,
        memory_kb: None,
        flags,
        details,
        children: children.into_iter().map(operator).collect(),
    }
}
