use super::*;
#[test]
fn invalid_examples_are_rejected() {
    for example in [
        json!([{"status": 99}]),
        json!([{"path": "relative"}]),
        json!([{"method": "GE T"}]),
        json!([{"headers": {"bad header": "x"}}]),
        json!({"not": "array"}),
    ] {
        assert!(normalize_examples(&example).is_err(), "{example}");
    }
}
#[tokio::test]
async fn mocks_answer_and_record_calls() {
    let mocks = Mocks::default();
    let started = mocks
        .start(&json!({"id": "m", "examples": [
            {"method": "post", "path": "/a", "status": 201, "headers": {"x-mock": "1"}, "body": {"ok": true}},
            {"path": "*", "body": "fallback"}
        ]}))
        .await
        .unwrap();
    let url = started["url"].as_str().unwrap();
    let client = reqwest::Client::builder().no_proxy().build().unwrap();
    let created = client
        .post(format!("{url}/a"))
        .body("hello")
        .send()
        .await
        .unwrap();
    assert_eq!(created.status(), 201);
    assert_eq!(created.headers()["x-mock"], "1");
    assert_eq!(created.text().await.unwrap(), "{\"ok\":true}");
    assert_eq!(
        client
            .get(format!("{url}/b"))
            .send()
            .await
            .unwrap()
            .text()
            .await
            .unwrap(),
        "fallback"
    );
    assert_eq!(mocks.list()[0]["calls"][0]["body"], "hello");
    assert_eq!(
        mocks.ports(),
        vec![started["port"].as_u64().unwrap() as u16]
    );
    assert!(mocks.start(&json!({"id": "m"})).await.is_err());
    mocks.stop(&json!({"id": "m"})).unwrap();
    assert!(mocks.list().as_array().unwrap().is_empty());
}
