//! Searching a session: what the driver is asked, and the confirmation of data on production.
use super::*;

#[tokio::test]
async fn objects_and_data_are_searched_by_the_driver() {
    let (application, _, sources) = with_sources(json!({}));
    connect(&application, "s1").await.unwrap();
    let found = application
        .execute(
            Operation::DbSearch,
            json!({"session": "s1", "statement": "find-1", "text": "%order%", "kinds": ["table"], "code": true}),
        )
        .await
        .unwrap();
    assert_eq!(found["objects"][0]["name"], "orders");
    let (session, request) = sources.searched.lock().unwrap()[0].clone();
    assert_eq!(session, "s1");
    assert_eq!(request["mode"], "metadata");
    assert_eq!(request["code"], true);
    assert_eq!(request["kinds"], json!(["table"]));

    let (application, _, sources) = with_sources(json!({"type": "production"}));
    connect(&application, "s1").await.unwrap();
    let data = json!({"session": "s1", "statement": "find-2", "text": "Ana", "mode": "data",
                      "tables": [{"name": "people"}]});
    let unconfirmed = application.execute(Operation::DbSearch, data.clone()).await;
    assert!(message(unconfirmed).contains("for production"));
    let mut confirmed = data;
    confirmed["confirm"] = json!(true);
    application
        .execute(Operation::DbSearch, confirmed)
        .await
        .unwrap();
    assert_eq!(
        sources.searched.lock().unwrap()[0].1["tables"][0]["name"],
        "people"
    );
    // Searching objects reads only the catalog: no confirmation, even on production.
    application
        .execute(
            Operation::DbSearch,
            json!({"session": "s1", "statement": "find-3", "text": "people"}),
        )
        .await
        .unwrap();
}
