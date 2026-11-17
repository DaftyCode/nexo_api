//! Execution plans of the PostgreSQL driver against the fixture: a filter without an index
//! reads the whole table and uses the index once it exists, and the actual plan of an
//! `UPDATE` measures it and changes nothing.
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
async fn plans_follow_the_indexes_and_the_actual_plan_of_a_write_changes_nothing() {
    let connect = fixture!(params("plans", None));
    let client = driver();
    client.connect(&connect).await.unwrap();
    run(&client, "plans", "DROP TABLE IF EXISTS public.plan_rows")
        .await
        .unwrap();
    run(
        &client,
        "plans",
        "CREATE TABLE public.plan_rows (id int, label text)",
    )
    .await
    .unwrap();
    run(
        &client,
        "plans",
        "INSERT INTO public.plan_rows SELECT n, 'row ' || n FROM generate_series(1, 20000) n",
    )
    .await
    .unwrap();
    run(&client, "plans", "ANALYZE public.plan_rows")
        .await
        .unwrap();

    let query = "SELECT label FROM public.plan_rows WHERE id = $1;";
    let plan = client
        .explain(&explain(query, ExplainMode::Estimated, false))
        .await
        .unwrap();
    let scan = all(&plan.nodes)
        .into_iter()
        .find(|node| node.object.as_deref() == Some("plan_rows"))
        .unwrap();
    assert!(scan.flags.contains(&flags::FULL_SCAN.to_owned()));
    assert!(plan.original.contains("\"Plan\""));

    run(
        &client,
        "plans",
        "CREATE INDEX plan_rows_id ON public.plan_rows (id)",
    )
    .await
    .unwrap();
    run(&client, "plans", "ANALYZE public.plan_rows")
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

    let update = "UPDATE public.plan_rows SET label = 'changed' WHERE id <= $1";
    let plan = client
        .explain(&explain(update, ExplainMode::Actual, true))
        .await
        .unwrap();
    assert!(plan.rolled_back);
    assert!(plan.total_ms.is_some());
    assert_eq!(plan.nodes[0].operation, "Update");
    assert!(plan.nodes[0].actual_ms.is_some());
    let changed = single(
        &client,
        "plans",
        "SELECT count(*) FROM public.plan_rows WHERE label = 'changed'",
    )
    .await;
    assert_eq!(changed, Value::Integer(0));
    // The session is left as it was: no transaction open.
    let state = client
        .transaction(&nexo_driver_sdk::statements::TransactionParams {
            connection: "plans".into(),
            action: nexo_driver_sdk::statements::TransactionAction::Status,
            isolation: None,
        })
        .await
        .unwrap();
    assert!(!state.open);
    run(&client, "plans", "DROP TABLE public.plan_rows")
        .await
        .unwrap();
}
