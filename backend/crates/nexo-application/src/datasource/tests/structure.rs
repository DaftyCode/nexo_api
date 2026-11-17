//! The structure editor: the model and the plan come from the driver, and a read-only
//! connection plans no change.
use super::*;

#[tokio::test]
async fn the_driver_reads_the_model_and_plans_the_change() {
    let (application, _, _) = with_sources(json!({}));
    connect(&application, "s1").await.unwrap();
    let model = application
        .execute(
            Operation::DbDdlModel,
            json!({"session": "s1", "path": ["shop", "schemas", "public", "tables", "items"]}),
        )
        .await
        .unwrap();
    assert_eq!(model["table"]["name"], "items");
    assert_eq!(model["types"][0], "integer");
    let plan = application
        .execute(
            Operation::DbDdlPlan,
            json!({"session": "s1", "original": {"name": "t"}, "target": {"name": "t"}}),
        )
        .await
        .unwrap();
    assert_eq!(plan["statements"][0], "ALTER TABLE t ADD COLUMN c text");

    let (application, _, _) = with_sources(json!({"readOnly": true}));
    connect(&application, "s1").await.unwrap();
    let refused = application
        .execute(
            Operation::DbDdlPlan,
            json!({"session": "s1", "original": {"name": "t"}}),
        )
        .await;
    assert!(message(refused).contains("read-only"));
}
