//! Rows changed in the data grid: the rules of a save, and what it leaves recorded.
use super::*;

fn change(kind: &str) -> Value {
    json!({"kind": kind, "key": [{"column": "id", "value": 1}], "values": [{"column": "a", "value": 2}]})
}
async fn save(application: &Application, changes: Vec<Value>, confirm: bool) -> Result<Value> {
    application
        .execute(
            Operation::DbRowsWrite,
            json!({"session": "s1", "table": "t", "changes": changes, "confirm": confirm}),
        )
        .await
}

#[tokio::test]
async fn a_save_is_written_by_the_driver_and_recorded() {
    let (application, fake, sources) = with_sources(json!({}));
    connect(&application, "s1").await.unwrap();
    let written = save(&application, vec![change("update")], false)
        .await
        .unwrap();
    assert_eq!(written["affected"], 1);
    let (session, request) = sources.written.lock().unwrap()[0].clone();
    assert_eq!(session, "s1");
    assert_eq!(request["table"], "t");
    assert_eq!(request["optimistic"], false);
    // The history keeps the statements, with placeholders instead of values.
    let sql = fake
        .documents
        .lock()
        .unwrap()
        .iter()
        .find(|d| d.kind.as_str() == "sql-history")
        .map(|entry| entry.value["sql"].clone())
        .unwrap();
    assert!(sql.as_str().unwrap().starts_with("UPDATE"));
    assert!(message(save(&application, Vec::new(), false).await).contains("nothing to save"));
}

#[tokio::test]
async fn read_only_production_and_many_deletes_are_refused_or_confirmed() {
    let (application, _, _) = with_sources(json!({"readOnly": true}));
    connect(&application, "s1").await.unwrap();
    let refused = save(&application, vec![change("update")], true).await;
    assert!(message(refused).contains("read-only"));

    let (application, _, sources) = with_sources(json!({"type": "production"}));
    connect(&application, "s1").await.unwrap();
    let unconfirmed = save(&application, vec![change("update")], false).await;
    assert!(message(unconfirmed).contains("for production"));
    save(&application, vec![change("update")], true)
        .await
        .unwrap();

    let (application, _, _) = with_sources(json!({}));
    connect(&application, "s1").await.unwrap();
    let many = vec![change("delete"); 101];
    assert!(message(save(&application, many.clone(), false).await).contains("deletes 101 rows"));
    save(&application, many, true).await.unwrap();
    assert_eq!(sources.written.lock().unwrap().len(), 1);
}
