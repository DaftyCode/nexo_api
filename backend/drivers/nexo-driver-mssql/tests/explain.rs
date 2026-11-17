//! Execution plans of the SQL Server driver against the fixture: a filter without an index
//! scans the table and seeks the index once it exists; a query and a change are measured,
//! and the change is rolled back; the session is left without its plan settings.
mod common;

use common::{driver, params, run, single};
use nexo_driver_sdk::{
    Value,
    explain::{ExplainMode, ExplainParams, PlanNode, flags},
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

#[tokio::test]
async fn plans_follow_the_indexes_and_a_measured_change_is_rolled_back() {
    let connect = fixture!(params("plans"));
    let client = driver();
    client.connect(&connect).await.unwrap();
    run(&client, "plans", "DROP TABLE IF EXISTS dbo.plan_rows")
        .await
        .unwrap();
    run(
        &client,
        "plans",
        "CREATE TABLE dbo.plan_rows (id int NOT NULL, label nvarchar(30))",
    )
    .await
    .unwrap();
    run(
        &client,
        "plans",
        "INSERT INTO dbo.plan_rows SELECT n, CONCAT('row ', n) FROM dbo.numbers WHERE n <= 5000",
    )
    .await
    .unwrap();

    let query = "SELECT label FROM dbo.plan_rows WHERE id = @P1";
    let plan = client
        .explain(&explain(query, ExplainMode::Estimated, false))
        .await
        .unwrap();
    assert_eq!(plan.format, "xml");
    assert!(
        all(&plan.nodes)
            .iter()
            .any(|node| node.flags.contains(&flags::FULL_SCAN.to_owned()))
    );

    run(
        &client,
        "plans",
        "CREATE CLUSTERED INDEX plan_rows_id ON dbo.plan_rows (id)",
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
            .any(|node| node.actual_rows == Some(1.0))
    );

    let update = "UPDATE dbo.plan_rows SET label = 'changed' WHERE id <= @P1";
    let plan = client
        .explain(&explain(update, ExplainMode::Actual, true))
        .await
        .unwrap();
    assert!(plan.rolled_back);
    assert!(
        all(&plan.nodes)
            .iter()
            .any(|node| node.actual_rows == Some(500.0))
    );
    let changed = single(
        &client,
        "plans",
        "SELECT count(*) FROM dbo.plan_rows WHERE label = 'changed'",
    )
    .await;
    assert_eq!(changed, Value::Integer(0));
    // Without SHOWPLAN or STATISTICS XML left on, a query answers its rows again.
    let rows = run(
        &client,
        "plans",
        "SELECT label FROM dbo.plan_rows WHERE id = 1",
    )
    .await
    .unwrap();
    assert_eq!(rows.rows, vec![vec![Value::Text("row 1".into())]]);
    assert!(rows.results.is_empty());
    run(&client, "plans", "DROP TABLE dbo.plan_rows")
        .await
        .unwrap();
}
