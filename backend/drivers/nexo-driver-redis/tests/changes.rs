//! Changes, the console and subscriptions of the Redis module against the fixture, and an
//! address the egress policy refuses.
mod common;

use common::{Host, driver, driver_with, kv, params};
use nexo_driver_sdk::{Client, Result, Value, keyvalue::methods};
use serde_json::{Value as Json, json};

async fn write(client: &Client, params: Json) -> Result<Json> {
    kv(client, methods::WRITE, "changes", params).await
}

#[tokio::test]
async fn keys_are_created_changed_renamed_expired_and_deleted_without_losing_bytes() {
    let connect = fixture!(params("changes", "VALKEY"));
    let client = driver();
    client.connect(&connect).await.unwrap();
    let get = |key: &'static str| {
        let client = client.clone();
        async move {
            kv(&client, methods::GET, "changes", json!({"key": key}))
                .await
                .unwrap()
        }
    };
    let binary = Json::from(Value::bytes(&[0xff, 0, 1, 0x80]));
    let new = json!({"key": "t:bin", "type": "string", "value": binary});
    write(&client, new).await.unwrap();
    assert_eq!(get("t:bin").await["value"], binary);
    // An existing key is never overwritten by «new key».
    let again = json!({"key": "t:bin", "type": "string", "value": "x"});
    let again = write(&client, again).await.unwrap_err();
    assert!(again.message.contains("already exists"));
    // A new value keeps the expiry.
    let expire = json!({"key": "t:bin", "action": "expire", "ttlMs": 600000});
    write(&client, expire).await.unwrap();
    write(&client, json!({"key": "t:bin", "value": "text"}))
        .await
        .unwrap();
    let changed = get("t:bin").await;
    assert_eq!(changed["value"], "text");
    assert!(changed["ttlMs"].as_i64().unwrap() > 0);
    write(&client, json!({"key": "t:bin", "action": "expire"}))
        .await
        .unwrap();
    assert!(get("t:bin").await["ttlMs"].is_null());
    let rename = json!({"key": "t:bin", "action": "rename", "to": "t:renamed"});
    write(&client, rename).await.unwrap();
    write(&client, json!({"key": "t:renamed", "action": "delete"}))
        .await
        .unwrap();
    let gone = json!({"key": "t:renamed"});
    assert!(kv(&client, methods::GET, "changes", gone).await.is_err());

    for change in [
        json!({"key": "t:h", "type": "hash", "field": "a", "value": "1"}),
        json!({"key": "t:h", "action": "put", "field": "b", "value": binary}),
        json!({"key": "t:h", "action": "remove", "field": "a"}),
        json!({"key": "t:z", "type": "zset", "value": "m", "score": 1}),
        json!({"key": "t:z", "action": "put", "field": "m", "value": "n", "score": 2}),
        json!({"key": "t:l", "type": "list", "value": "a"}),
        json!({"key": "t:l", "action": "put", "value": "b"}),
        json!({"key": "t:l", "action": "put", "index": 0, "value": "z"}),
        json!({"key": "t:l", "action": "remove", "value": "b"}),
        json!({"key": "t:s", "type": "stream", "fields": [["f", "v"]]}),
    ] {
        write(&client, change.clone())
            .await
            .unwrap_or_else(|error| panic!("{change}: {error}"));
    }
    let hash = json!([{"field": "b", "value": binary}]);
    assert_eq!(get("t:h").await["elements"], hash);
    let zset = json!([{"score": 2.0, "value": "n"}]);
    assert_eq!(get("t:z").await["elements"], zset);
    assert_eq!(
        get("t:l").await["elements"],
        json!([{"index": 0, "value": "z"}])
    );
    assert_eq!(get("t:s").await["length"], 1);
    // A change to a key that is not there.
    let missing = json!({"key": "t:none", "action": "put", "value": "x"});
    assert!(write(&client, missing).await.is_err());
    for key in ["t:h", "t:z", "t:l", "t:s"] {
        write(&client, json!({"key": key, "action": "delete"}))
            .await
            .unwrap();
    }
}

#[tokio::test]
async fn the_console_answers_and_never_takes_the_connection() {
    let connect = fixture!(params("changes", "REDIS"));
    let client = driver();
    client.connect(&connect).await.unwrap();
    let run = |args: Json| {
        let client = client.clone();
        async move { kv(&client, methods::COMMAND, "changes", json!({"args": args})).await }
    };
    let set = run(json!(["SET", "t:c", "it's"])).await.unwrap();
    assert_eq!(set["reply"], "OK");
    assert_eq!(run(json!(["GET", "t:c"])).await.unwrap()["reply"], "it's");
    let hash = run(json!(["HGETALL", "user:1"])).await.unwrap();
    assert_eq!(hash["reply"], json!(["name", "Ana", "city", "Lima"]));
    let wrong = run(json!(["INCR", "t:c"])).await.unwrap();
    let error = wrong["reply"]["error"].as_str().unwrap();
    assert!(error.contains("not an integer"), "{error}");
    let refused = run(json!(["SUBSCRIBE", "news"])).await.unwrap_err();
    assert!(refused.message.contains("realtime panel"));
    run(json!(["DEL", "t:c"])).await.unwrap();
}

#[tokio::test]
async fn a_message_published_reaches_the_subscription() {
    let connect = fixture!(params("changes", "REDIS"));
    let client = driver();
    client.connect(&connect).await.unwrap();
    let follow = json!({"channels": ["news"], "patterns": ["n*"]});
    let opened = kv(&client, methods::SUBSCRIBE, "changes", follow)
        .await
        .unwrap();
    let subscription = opened["subscription"].clone();
    let publish = json!({"args": ["PUBLISH", "news", "hello"]});
    kv(&client, methods::COMMAND, "changes", publish)
        .await
        .unwrap();
    let read = |after: u64| {
        let client = client.clone();
        let params = json!({"subscription": subscription, "after": after});
        async move { kv(&client, methods::EVENTS, "changes", params).await }
    };
    let mut events = Json::Null;
    for _ in 0..50 {
        events = read(0).await.unwrap();
        if events["events"].as_array().unwrap().len() >= 2 {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
    assert_eq!(events["state"], "connected");
    let all = events["events"].as_array().unwrap();
    let kinds: Vec<&str> = all.iter().map(|e| e["type"].as_str().unwrap()).collect();
    assert!(
        kinds.contains(&"message") && kinds.contains(&"pmessage"),
        "{events}"
    );
    assert!(
        all.iter()
            .all(|e| e["payload"] == "hello" && e["channel"] == "news")
    );
    assert!(
        read(2).await.unwrap()["events"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    let close = json!({"subscription": subscription});
    kv(&client, methods::UNSUBSCRIBE, "changes", close)
        .await
        .unwrap();
    assert!(read(0).await.is_err());
}

#[tokio::test]
async fn an_address_the_policy_refuses_is_never_connected() {
    let connect = fixture!(params("refused", "REDIS"));
    let host = Host::default();
    host.refused
        .lock()
        .unwrap()
        .push(connect.host.clone().unwrap());
    let error = driver_with(host.clone())
        .connect(&connect)
        .await
        .unwrap_err();
    assert!(error.message.contains("egress policy"), "{error}");
}
