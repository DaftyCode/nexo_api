//! Execution plans: the estimated one of anything, the actual one with its rules.
use super::*;

async fn explain(application: &Application, sql: &str, mode: &str, confirm: bool) -> Result<Value> {
    application
        .execute(
            Operation::DbExplain,
            json!({"session": "s1", "statement": "plan-1", "sql": sql, "params": [5], "mode": mode, "confirm": confirm}),
        )
        .await
}

#[tokio::test]
async fn the_driver_explains_with_what_the_statement_does() {
    let (application, fake, sources) = with_sources(json!({}));
    connect(&application, "s1").await.unwrap();
    let plan = explain(
        &application,
        "SELECT * FROM t WHERE id = $1",
        "estimated",
        false,
    )
    .await
    .unwrap();
    assert_eq!(plan["nodes"][0]["operation"], "Seq Scan");
    let measured = explain(&application, "UPDATE t SET a = 1", "actual", true)
        .await
        .unwrap();
    assert_eq!(measured["rolledBack"], true);
    let asked = sources.explained.lock().unwrap().clone();
    assert_eq!(asked[0].0, "s1");
    assert_eq!(asked[0].1["writes"], false);
    assert_eq!(asked[0].1["params"], json!([5]));
    assert_eq!(asked[1].1["mode"], "actual");
    assert_eq!(asked[1].1["writes"], true);
    // A plan is not a statement of the history.
    let history = fake
        .documents
        .lock()
        .unwrap()
        .iter()
        .filter(|document| document.kind.as_str() == "sql-history")
        .count();
    assert_eq!(history, 0);
}

#[tokio::test]
async fn the_actual_plan_of_a_change_is_confirmed_and_never_on_read_only() {
    let (application, _, sources) = with_sources(json!({}));
    connect(&application, "s1").await.unwrap();
    let unconfirmed = explain(&application, "DELETE FROM t WHERE id = 1", "actual", false).await;
    assert!(message(unconfirmed).contains("Confirm the actual plan"));
    let structure = explain(&application, "DROP TABLE t", "actual", true).await;
    assert!(message(structure).contains("change of structure"));
    let truncate = explain(&application, "TRUNCATE TABLE t", "actual", true).await;
    assert!(message(truncate).contains("change of structure"));
    let unknown = explain(&application, "SELECT 1", "slow", false).await;
    assert!(message(unknown).contains("Unknown plan mode"));
    assert!(sources.explained.lock().unwrap().is_empty());

    let (application, _, sources) = with_sources(json!({"readOnly": true}));
    connect(&application, "s1").await.unwrap();
    let refused = explain(&application, "UPDATE t SET a = 1", "actual", true).await;
    assert!(message(refused).contains("read-only"));
    // Estimating runs nothing: also a change, also on a read-only connection.
    explain(&application, "UPDATE t SET a = 1", "estimated", false)
        .await
        .unwrap();
    explain(&application, "SELECT 1", "actual", false)
        .await
        .unwrap();
    assert_eq!(sources.explained.lock().unwrap().len(), 2);
}
