//! Execution plans: `EXPLAIN QUERY PLAN`, read into the shared form of
//! [`nexo_driver_sdk::explain`]. SQLite only plans: it has no actual mode.
#[cfg(test)]
mod tests;

use nexo_driver_sdk::{
    DriverError, Result,
    explain::{ExplainMode, ExplainParams, PlanNode, PlanRead, PlanReader, Steps, flags, text_of},
    statements::ExecuteResult,
};

pub struct SqlitePlans;

impl PlanReader for SqlitePlans {
    fn steps(&self, params: &ExplainParams) -> Result<Steps> {
        if params.mode == ExplainMode::Actual {
            return Err(DriverError::unsupported(
                "SQLite only estimates plans: it has no actual mode",
            ));
        }
        let sql = params.sql.trim().trim_end_matches(';').trim_end();
        Ok(Steps {
            plan: format!("EXPLAIN QUERY PLAN {sql}"),
            ..Steps::default()
        })
    }

    fn read(&self, answer: &ExecuteResult, _mode: ExplainMode) -> Result<PlanRead> {
        let column = |name| text_of(&answer.columns, &answer.rows, Some(name));
        let (ids, parents, details) = (column("id"), column("parent"), column("detail"));
        let lines: Vec<String> = ids
            .lines()
            .zip(parents.lines())
            .zip(details.lines())
            .map(|((id, parent), detail)| format!("{id}|{parent}|{detail}"))
            .collect();
        read(&lines.join("\n"))
    }
}

/// One line of the plan: its id, its parent's and what it says.
struct Line<'a> {
    id: &'a str,
    parent: &'a str,
    detail: &'a str,
}

/// The plan of `EXPLAIN QUERY PLAN`'s rows, written `id|parent|detail` one per line.
pub fn read(rows: &str) -> Result<PlanRead> {
    let lines: Vec<Line> = rows
        .lines()
        .filter(|line| !line.trim().is_empty())
        .map(|line| {
            let mut parts = line.splitn(3, '|');
            match (parts.next(), parts.next(), parts.next()) {
                (Some(id), Some(parent), Some(detail)) => Ok(Line { id, parent, detail }),
                _ => Err(DriverError::internal(
                    "SQLite answered a plan Nexo cannot read",
                )),
            }
        })
        .collect::<Result<_>>()?;
    let ids: Vec<&str> = lines.iter().map(|line| line.id).collect();
    // Lines whose parent is not a line are at the top (the parent of those is 0).
    let tops: Vec<&Line> = lines
        .iter()
        .filter(|line| !ids.contains(&line.parent))
        .collect();
    let nodes: Vec<PlanNode> = tops.iter().map(|line| node(line, &lines)).collect();
    let mut original = String::from("QUERY PLAN\n");
    shell_text(&nodes, "", &mut original);
    Ok(PlanRead {
        nodes,
        format: "text",
        original: original.trim_end().to_owned(),
        total_ms: None,
    })
}

/// The plan drawn as the `sqlite3` shell draws it.
fn shell_text(nodes: &[PlanNode], indent: &str, out: &mut String) {
    for (index, node) in nodes.iter().enumerate() {
        let last = index + 1 == nodes.len();
        let detail = node.details.get("detail").map_or("", String::as_str);
        out.push_str(&format!(
            "{indent}{}{detail}\n",
            if last { "`--" } else { "|--" }
        ));
        let deeper = format!("{indent}{}", if last { "   " } else { "|  " });
        shell_text(&node.children, &deeper, out);
    }
}

fn node(line: &Line, all: &[Line]) -> PlanNode {
    let detail = line.detail.trim();
    let mut found = PlanNode {
        operation: detail.to_owned(),
        ..PlanNode::default()
    };
    found.details.insert("detail".into(), detail.to_owned());
    let words: Vec<&str> = detail.split_whitespace().collect();
    if let Some(&verb @ ("SCAN" | "SEARCH")) = words.first() {
        // `SCAN t`, `SEARCH t USING INDEX i (a=?)`; before 3.36, `SCAN TABLE t AS a`.
        let rest = &words[1..];
        let rest = if rest.first() == Some(&"TABLE") {
            &rest[1..]
        } else {
            rest
        };
        found.operation = verb.to_owned();
        found.object = rest.first().map(|name| (*name).to_owned());
        if let (Some(&"AS"), Some(alias)) = (rest.get(1), rest.get(2)) {
            found.details.insert("Alias".into(), (*alias).to_owned());
        }
        if let Some(at) = detail.find(" USING ") {
            let using = detail[at + 7..].split(" (").next().unwrap_or_default();
            // `INDEX i`, `COVERING INDEX i`, `AUTOMATIC COVERING INDEX i`, or a key.
            let (kind, index) = match using.find("INDEX ") {
                Some(end) => (&using[..end + 5], using[end + 6..].trim()),
                None => (using, using),
            };
            found.operation = format!("{verb} USING {kind}");
            found.index = Some(index.to_owned());
        } else if verb == "SCAN" {
            found.flags.push(flags::FULL_SCAN.to_owned());
        }
        if let (Some(open), Some(close)) = (detail.rfind(" ("), detail.rfind(')')) {
            found.condition = Some(detail[open + 2..close].to_owned());
        }
    }
    if detail.starts_with("USE TEMP B-TREE") {
        found.flags.push(flags::TEMPORARY.to_owned());
    }
    found.children = all
        .iter()
        .filter(|child| child.parent == line.id)
        .map(|child| node(child, all))
        .collect();
    found
}
