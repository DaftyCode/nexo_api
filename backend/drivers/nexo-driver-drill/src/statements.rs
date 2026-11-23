//! Statements of Drill: pages read by running the statement again (its REST API does not
//! page), a running statement found in `/profiles` and cancelled, and its plan.
use crate::{rest::Drill, values};
use nexo_driver_sdk::{
    Result,
    explain::{ExplainMode, Plan, PlanNode},
};

/// A statement read a page at a time: the next rows after `offset`.
pub(crate) fn paged(sql: &str, rows: u64, offset: u64) -> String {
    format!(
        "SELECT * FROM ({sql}) nexo_page LIMIT {} OFFSET {offset}",
        rows + 1
    )
}

/// Whether a statement returns rows that can be paged.
pub(crate) fn pageable(sql: &str) -> bool {
    let first = sql
        .split_whitespace()
        .next()
        .unwrap_or_default()
        .to_ascii_uppercase();
    matches!(first.as_str(), "SELECT" | "WITH" | "VALUES")
}

/// Cancels the queries running that are `sql`. Only the running ones are listed: reading the
/// finished ones too (`/profiles.json`) fails now and then while Drill writes one.
pub(crate) async fn cancel(drill: &Drill, sql: &str) -> Result<()> {
    let profiles = drill.send("GET", "/profiles/running.json", None).await?;
    let running = profiles["runningQueries"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    let wanted = sql.split_whitespace().collect::<Vec<_>>().join(" ");
    for query in running {
        let text = query["query"].as_str().unwrap_or_default();
        if text
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ")
            .contains(&wanted)
        {
            let id = query["queryId"].as_str().unwrap_or_default();
            if id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
                drill
                    .send("GET", &format!("/profiles/cancel/{id}"), None)
                    .await
                    .ok();
            }
        }
    }
    Ok(())
}

/// The plan of a statement, as `EXPLAIN PLAN FOR` writes it.
pub(crate) async fn explain(drill: &Drill, sql: &str) -> Result<Plan> {
    let answer = drill
        .query(&format!("EXPLAIN PLAN FOR {sql}"), None)
        .await?;
    let (_, found) = values::rows(&answer);
    let text = found
        .first()
        .and_then(|row| row.first())
        .map(|value| match value {
            nexo_driver_sdk::Value::Text(text) => text.clone(),
            other => format!("{other:?}"),
        });
    let original = text.unwrap_or_default();
    let nodes = original
        .lines()
        .filter(|line| !line.trim().is_empty())
        .take(1)
        .map(|line| PlanNode {
            operation: line.trim().to_owned(),
            ..PlanNode::default()
        })
        .collect();
    Ok(Plan {
        mode: ExplainMode::Estimated,
        nodes,
        format: "text".into(),
        original,
        total_ms: None,
        rolled_back: false,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_page_runs_the_statement_again_from_where_it_stopped() {
        assert_eq!(
            paged("SELECT * FROM cp.`employee.json`", 200, 400),
            "SELECT * FROM (SELECT * FROM cp.`employee.json`) nexo_page LIMIT 201 OFFSET 400"
        );
        assert!(pageable("  with x as (select 1) select * from x"));
        assert!(!pageable("SHOW SCHEMAS"));
        assert!(!pageable("CREATE TABLE dfs.tmp.t AS SELECT 1"));
    }
}
