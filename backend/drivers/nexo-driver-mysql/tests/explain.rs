//! Execution plans of the MySQL driver against MySQL 8.4 and MariaDB 11.4: a filter without
//! an index reads the whole table and uses the index once it exists; a query is measured on
//! both; MariaDB measures a change and rolls it back, MySQL refuses to run one.
mod common;

use common::{driver, mariadb, params, run, single};
use nexo_driver_sdk::{
    Client, ErrorCode, Value,
    explain::{ExplainMode, ExplainParams, PlanNode, flags},
    protocol::ConnectParams,
};

fn explain(sql: &str, mode: ExplainMode, writes: bool) -> ExplainParams {
    ExplainParams {
        connection: "plans".into(),
        statement: "plan-1".into(),
        sql: sql.into(),
        params: vec![Value::Integer(500)],
        mode,
        writes,
    }
}
fn all(nodes: &[PlanNode]) -> Vec<&PlanNode> {
    nodes
        .iter()
        .flat_map(|node| std::iter::once(node).chain(all(&node.children)))
        .collect()
}

/// A table of 5 000 rows without an index on `id`.
async fn table(client: &Client) {
    run(client, "plans", "DROP TABLE IF EXISTS plan_rows")
        .await
        .unwrap();
    run(
        client,
        "plans",
        "CREATE TABLE plan_rows (id int, label varchar(30))",
    )
    .await
    .unwrap();
    run(
        client,
        "plans",
        "INSERT INTO plan_rows SELECT n, CONCAT('row ', n) FROM numbers WHERE n <= 5000",
    )
    .await
    .unwrap();
    run(client, "plans", "ANALYZE TABLE plan_rows")
        .await
        .unwrap();
}

async fn check(connect: ConnectParams, measures_changes: bool) {
    let client = driver();
    client.connect(&connect).await.unwrap();
    table(&client).await;
    let query = "SELECT label FROM plan_rows WHERE id = ?";
    let plan = client
        .explain(&explain(query, ExplainMode::Estimated, false))
        .await
        .unwrap();
    let scan = all(&plan.nodes)
        .into_iter()
        .find(|node| node.object.is_some())
        .unwrap();
    assert!(scan.flags.contains(&flags::FULL_SCAN.to_owned()));

    run(
        &client,
        "plans",
        "CREATE INDEX plan_rows_id ON plan_rows (id)",
    )
    .await
    .unwrap();
    let plan = client
        .explain(&explain(query, ExplainMode::Estimated, false))
        .await
        .unwrap();
    assert!(
        all(&plan.nodes)
            .iter()
            .any(|node| node.index.as_deref() == Some("plan_rows_id"))
    );
    let measured = client
        .explain(&explain(query, ExplainMode::Actual, false))
        .await
        .unwrap();
    assert!(
        all(&measured.nodes)
            .iter()
            .any(|node| node.actual_rows.is_some())
    );

    let update = "UPDATE plan_rows SET label = 'changed' WHERE id <= ?";
    let answer = client
        .explain(&explain(update, ExplainMode::Actual, true))
        .await;
    if measures_changes {
        let plan = answer.unwrap();
        assert!(plan.rolled_back);
    } else {
        assert_eq!(answer.unwrap_err().code, ErrorCode::Unsupported);
    }
    let changed = single(
        &client,
        "plans",
        "SELECT count(*) FROM plan_rows WHERE label = 'changed'",
    )
    .await;
    assert_eq!(changed, Value::Integer(0));
    run(&client, "plans", "DROP TABLE plan_rows").await.unwrap();
}

#[tokio::test]
async fn mysql_plans_follow_the_indexes_and_measure_only_queries() {
    check(fixture!(params("plans")), false).await;
}

#[tokio::test]
async fn mariadb_plans_follow_the_indexes_and_measure_changes_rolled_back() {
    check(fixture!(mariadb("plans")), true).await;
}
