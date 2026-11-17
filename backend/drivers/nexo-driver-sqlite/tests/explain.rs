//! Execution plans of the SQLite driver: a filter without an index scans the table and
//! searches the index once it exists; the actual mode is refused, as SQLite has none.
mod common;

use common::{Folder, database, driver, params, run};
use nexo_driver_sdk::{
    ErrorCode, Value,
    explain::{ExplainMode, ExplainParams, flags},
};

fn explain(sql: &str, mode: ExplainMode) -> ExplainParams {
    ExplainParams {
        connection: "plans".into(),
        statement: "plan-1".into(),
        sql: sql.into(),
        params: vec![Value::Integer(7)],
        mode,
        writes: false,
    }
}

#[tokio::test]
async fn plans_follow_the_indexes_and_the_actual_mode_is_refused() {
    let folder = Folder::new("plans");
    let path = database(
        &folder,
        "plans.db",
        "CREATE TABLE items (id INTEGER, label TEXT);",
    );
    let client = driver();
    client.connect(&params("plans", &path)).await.unwrap();
    let query = "SELECT label FROM items WHERE id = ?;";
    let plan = client
        .explain(&explain(query, ExplainMode::Estimated))
        .await
        .unwrap();
    assert_eq!(plan.format, "text");
    assert_eq!(plan.nodes[0].operation, "SCAN");
    assert!(plan.nodes[0].flags.contains(&flags::FULL_SCAN.to_owned()));

    run(&client, "plans", "CREATE INDEX items_id ON items (id)")
        .await
        .unwrap();
    let plan = client
        .explain(&explain(query, ExplainMode::Estimated))
        .await
        .unwrap();
    assert_eq!(plan.nodes[0].index.as_deref(), Some("items_id"));
    assert!(plan.original.contains("SEARCH items USING INDEX items_id"));

    let refused = client
        .explain(&explain(query, ExplainMode::Actual))
        .await
        .unwrap_err();
    assert_eq!(refused.code, ErrorCode::Unsupported);
}
