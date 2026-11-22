//! Test data (DB-27): a batch shown, or written with the import of DB-17, the same for the
//! same seed; never into a read-only or production connection.
use super::*;

fn batch(write: bool, first: u64) -> Value {
    json!({"session": "s1", "table": "people", "seed": 42, "first": first, "count": 3,
    "write": write,
    "columns": [
        {"name": "id", "generator": {"kind": "sequence", "start": 1, "step": 1}},
        {"name": "email", "generator": {"kind": "catalog", "catalog": "email"}, "unique": true},
    ]})
}

#[tokio::test]
async fn a_batch_is_shown_or_written_and_the_same_seed_makes_the_same_rows() {
    let (application, _, sources) = with_sources(json!({}));
    connect(&application, "s1").await.unwrap();
    let shown = application
        .execute(Operation::DbMockRows, batch(false, 0))
        .await
        .unwrap();
    assert_eq!(shown["columns"], json!(["id", "email"]));
    assert_eq!(shown["rows"].as_array().unwrap().len(), 3);
    assert_eq!(shown["rows"][2][0], 3);
    assert!(sources.imported.lock().unwrap().is_empty());
    let again = application
        .execute(Operation::DbMockRows, batch(false, 0))
        .await
        .unwrap();
    assert_eq!(shown, again);

    let written = application
        .execute(Operation::DbMockRows, batch(true, 10))
        .await
        .unwrap();
    assert_eq!(written["inserted"], 3);
    let (_, request) = sources.imported.lock().unwrap()[0].clone();
    assert_eq!(request["table"], "people");
    assert_eq!(request["first"], 11);
    assert_eq!(request["stopOnError"], false);
    assert_eq!(request["rows"][0][0], 11);
}

#[tokio::test]
async fn production_and_read_only_connections_take_no_test_data() {
    for connection in [json!({"type": "production"}), json!({"readOnly": true})] {
        let (application, _, _) = with_sources(connection);
        connect(&application, "s1").await.unwrap();
        let refused = application
            .execute(Operation::DbMockRows, batch(false, 0))
            .await;
        assert!(message(refused).contains("does not take test data"));
    }
    let (application, _, _) = with_sources(json!({}));
    connect(&application, "s1").await.unwrap();
    let mut wrong = batch(false, 0);
    wrong["columns"][0]["generator"] = json!({"kind": "integer", "min": 5, "max": 1});
    assert!(message(application.execute(Operation::DbMockRows, wrong).await).contains("smallest"));
    let mut unknown = batch(false, 0);
    unknown["columns"][0]["generator"] = json!({"kind": "magic"});
    assert!(
        message(application.execute(Operation::DbMockRows, unknown).await).contains("not valid")
    );
    let beyond = batch(false, 1_000_000);
    assert!(message(application.execute(Operation::DbMockRows, beyond).await).contains("at most"));
}
