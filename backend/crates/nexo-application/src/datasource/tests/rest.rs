//! The HTTP APIs of Elasticsearch and OpenSearch (DB-36) with the rules of every connection.
use super::*;

async fn request(application: &Application, extra: Value) -> Result<Value> {
    let mut payload = json!({"session": "s1"});
    if let (Value::Object(payload), Value::Object(extra)) = (&mut payload, extra) {
        payload.extend(extra);
    }
    application.execute(Operation::DbRestRequest, payload).await
}

#[tokio::test]
async fn a_request_reads_or_writes_as_its_method_and_path_say() {
    let (application, _, sources) = with_sources(json!({"driver": "elastic", "readOnly": true}));
    connect(&application, "s1").await.unwrap();
    request(
        &application,
        json!({"method": "GET", "path": "_cat/indices"}),
    )
    .await
    .unwrap();
    let search =
        json!({"method": "POST", "path": "shop/_search", "body": {"query": {"match_all": {}}}});
    request(&application, search).await.unwrap();
    for refused in [
        json!({"method": "PUT", "path": "shop/_doc/1", "body": {"a": 1}}),
        json!({"method": "DELETE", "path": "shop", "confirmName": "shop"}),
    ] {
        assert!(message(request(&application, refused).await).contains("read-only"));
    }
    let calls = sources.key_values.lock().unwrap();
    assert_eq!(calls.len(), 2);
    assert_eq!(
        calls[1].2,
        json!({"method": "POST", "path": "shop/_search", "body": {"query": {"match_all": {}}}})
    );
}

#[tokio::test]
async fn deleting_an_index_asks_for_its_name_and_production_for_each_change() {
    let (application, _, _) = with_sources(json!({"driver": "elastic"}));
    connect(&application, "s1").await.unwrap();
    let delete = json!({"method": "DELETE", "path": "/shop"});
    assert!(message(request(&application, delete).await).contains("Type shop to confirm it"));
    let wildcard = json!({"method": "DELETE", "path": "logs-*", "confirmName": "logs"});
    assert!(message(request(&application, wildcard).await).contains("Type logs-* to confirm it"));
    let typed = json!({"method": "DELETE", "path": "/shop", "confirmName": "shop"});
    request(&application, typed).await.unwrap();
    let close = json!({"method": "POST", "path": "shop/_close"});
    assert!(request(&application, close).await.is_err());

    let (production, _, _) = with_sources(json!({"driver": "elastic", "type": "production"}));
    connect(&production, "s1").await.unwrap();
    request(&production, json!({"method": "GET", "path": "/"}))
        .await
        .unwrap();
    let put = json!({"method": "PUT", "path": "shop/_doc/1", "body": {}});
    assert!(message(request(&production, put.clone()).await).contains("confirm each change"));
    let mut confirmed = put;
    confirmed["confirm"] = json!(true);
    request(&production, confirmed).await.unwrap();
}
