//! A Kafka connection against a broker speaking the wire protocol.
use super::*;
use crate::realtime::*;

#[tokio::test]
async fn kafka_lists_topics_produces_and_reads() {
    let (port, _) = crate::kafka::tests::start(Default::default()).await;
    let realtime = realtime();
    let connected = realtime
        .connect(&json!({"protocol": "kafka", "url": format!("127.0.0.1:{port}")}))
        .await
        .unwrap();
    let id = connected["id"].as_str().unwrap();
    let has = |kind: &'static str| {
        move |polled: &Value| {
            polled["events"]
                .as_array()
                .unwrap()
                .iter()
                .any(|event| event["type"] == kind)
        }
    };
    let polled = wait_for(&realtime, id, has("topics")).await;
    assert_eq!(polled["state"], "connected");
    let topics = polled["events"]
        .as_array()
        .unwrap()
        .iter()
        .find(|e| e["type"] == "topics")
        .unwrap();
    assert_eq!(
        topics["data"],
        json!([{"name": "orders", "partitions": 2, "internal": false}])
    );

    realtime
        .send(
            &json!({"id": id, "action": "produce", "topic": "orders", "partition": 1,
            "key": "k1", "message": "hello", "headers": [{"key": "trace", "value": "t1"}]}),
        )
        .unwrap();
    wait_for(&realtime, id, has("produced")).await;
    realtime
        .send(&json!({"id": id, "action": "subscribe", "topic": "orders", "from": "earliest"}))
        .unwrap();
    let polled = wait_for(&realtime, id, has("message")).await;
    let message = polled["events"]
        .as_array()
        .unwrap()
        .iter()
        .find(|e| e["type"] == "message")
        .unwrap();
    assert_eq!(message["data"]["value"], "hello");
    assert_eq!(message["data"]["key"], "k1");
    assert_eq!(message["data"]["headers"], json!({"trace": "t1"}));
    assert_eq!(
        (
            message["data"]["partition"].clone(),
            message["data"]["offset"].clone()
        ),
        (json!(1), json!(0))
    );
    realtime
        .send(&json!({"id": id, "action": "unsubscribe"}))
        .unwrap();
    wait_for(&realtime, id, has("unsubscribed")).await;
    realtime
        .send(&json!({"id": id, "action": "topics"}))
        .unwrap();
    assert!(
        realtime
            .send(&json!({"id": id, "action": "produce"}))
            .unwrap_err()
            .to_string()
            .contains("Kafka topic")
    );
    assert!(
        realtime
            .send(&json!({"id": id, "action": "rewind", "topic": "a"}))
            .is_err()
    );
    realtime.disconnect(&json!({"id": id})).unwrap();

    assert!(
        realtime
            .connect(&json!({"protocol": "kafka", "url": ""}))
            .await
            .is_err()
    );
    let refused = realtime
        .connect(&json!({"protocol": "kafka", "url": "127.0.0.1:9"}))
        .await
        .unwrap();
    let polled = wait_for(&realtime, refused["id"].as_str().unwrap(), |p| {
        p["state"] == "error"
    })
    .await;
    assert!(
        polled["events"][0]["data"]
            .as_str()
            .unwrap()
            .contains("127.0.0.1:9")
    );
}
