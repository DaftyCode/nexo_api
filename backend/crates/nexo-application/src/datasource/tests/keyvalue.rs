//! The key-value stores (DB-35) with the rules of every connection, and their subscriptions
//! in the realtime panel.
use super::*;

async fn kv(application: &Application, operation: Operation, extra: Value) -> Result<Value> {
    let mut payload = json!({"session": "s1"});
    if let (Value::Object(payload), Value::Object(extra)) = (&mut payload, extra) {
        payload.extend(extra);
    }
    application.execute(operation, payload).await
}

#[tokio::test]
async fn keys_are_read_on_any_connection_and_changed_only_where_allowed() {
    let (application, _, sources) = with_sources(json!({"driver": "redis", "readOnly": true}));
    connect(&application, "s1").await.unwrap();
    kv(
        &application,
        Operation::DbKvScan,
        json!({"pattern": "user:*", "count": 50}),
    )
    .await
    .unwrap();
    kv(&application, Operation::DbKvGet, json!({"key": "user:1"}))
        .await
        .unwrap();
    // A read of the console passes; a write, in any form, does not.
    kv(
        &application,
        Operation::DbKvCommand,
        json!({"line": "GET user:1"}),
    )
    .await
    .unwrap();
    for refused in [
        kv(
            &application,
            Operation::DbKvCommand,
            json!({"line": "set k v"}),
        )
        .await,
        kv(
            &application,
            Operation::DbKvCommand,
            json!({"args": ["DEL", "k"]}),
        )
        .await,
        kv(
            &application,
            Operation::DbKvWrite,
            json!({"key": "k", "action": "set", "value": "v"}),
        )
        .await,
    ] {
        assert!(message(refused).contains("read-only"));
    }
    let calls = sources.key_values.lock().unwrap();
    let methods: Vec<&str> = calls.iter().map(|(_, method, _)| method.as_str()).collect();
    assert_eq!(methods, ["kv.scan", "kv.get", "kv.command"]);
    assert_eq!(calls[0].2, json!({"pattern": "user:*", "count": 50}));
    assert_eq!(calls[2].2, json!({"args": ["GET", "user:1"]}));
}

#[tokio::test]
async fn dangerous_commands_are_typed_and_production_confirms_each_change() {
    let (application, _, sources) = with_sources(json!({"driver": "redis"}));
    connect(&application, "s1").await.unwrap();
    let flush = message(
        kv(
            &application,
            Operation::DbKvCommand,
            json!({"line": "FLUSHDB"}),
        )
        .await,
    );
    assert!(flush.contains("Type FLUSHDB to confirm"), "{flush}");
    let wrong = json!({"line": "flushdb", "confirmName": "FLUSHALL"});
    assert!(
        kv(&application, Operation::DbKvCommand, wrong)
            .await
            .is_err()
    );
    let typed = json!({"line": "flushdb", "confirmName": "flushdb"});
    kv(&application, Operation::DbKvCommand, typed)
        .await
        .unwrap();
    let config = json!({"line": "CONFIG SET maxmemory 1", "confirmName": "CONFIG"});
    assert!(message(kv(&application, Operation::DbKvCommand, config).await).contains("CONFIG SET"));
    let subscribe = message(
        kv(
            &application,
            Operation::DbKvCommand,
            json!({"line": "SUBSCRIBE news"}),
        )
        .await,
    );
    assert!(subscribe.contains("realtime panel"));
    let open = message(
        kv(
            &application,
            Operation::DbKvCommand,
            json!({"line": "SET k \"open"}),
        )
        .await,
    );
    assert!(open.contains("not closed"));
    // A key is deleted only when confirmed.
    let delete = json!({"key": "k", "action": "delete"});
    assert!(message(kv(&application, Operation::DbKvWrite, delete).await).contains("Confirm"));
    let delete = json!({"key": "k", "action": "delete", "confirm": true});
    kv(&application, Operation::DbKvWrite, delete)
        .await
        .unwrap();
    // Bytes that are not UTF-8 travel as binary.
    kv(
        &application,
        Operation::DbKvCommand,
        json!({"line": "SET b \"\\xff\""}),
    )
    .await
    .unwrap();
    let last = sources.key_values.lock().unwrap().last().unwrap().2.clone();
    assert_eq!(
        last,
        json!({"args": ["SET", "b", {"$t": "binary", "v": "/w=="}]})
    );

    let (production, _, _) = with_sources(json!({"driver": "redis", "type": "production"}));
    connect(&production, "s1").await.unwrap();
    kv(
        &production,
        Operation::DbKvCommand,
        json!({"line": "GET k"}),
    )
    .await
    .unwrap();
    let set = message(
        kv(
            &production,
            Operation::DbKvCommand,
            json!({"line": "SET k v"}),
        )
        .await,
    );
    assert!(set.contains("asks to confirm each change"), "{set}");
    kv(
        &production,
        Operation::DbKvCommand,
        json!({"line": "SET k v", "confirm": true}),
    )
    .await
    .unwrap();
    let put = json!({"key": "k", "action": "set", "value": "v"});
    assert!(kv(&production, Operation::DbKvWrite, put).await.is_err());
}

#[tokio::test]
async fn a_subscription_is_a_held_session_the_realtime_panel_reads_and_closes() {
    let (application, _, sources) = with_sources(json!({"driver": "redis"}));
    let opened = application
        .execute(
            Operation::DbKvSubscribe,
            json!({"workspace": "local", "connectionId": "c1", "channels": ["news"],
                   "patterns": ["n*"], "variables": {"host": "db.test"}}),
        )
        .await
        .unwrap();
    let id = opened["id"].as_str().unwrap().to_owned();
    assert!(id.starts_with("redis-sub-") && id.ends_with(".s1"), "{id}");
    let session = id.rsplit_once('.').unwrap().0.to_owned();
    assert!(
        sources
            .held
            .lock()
            .unwrap()
            .contains(&(session.clone(), true))
    );
    let read = application
        .execute(Operation::RealtimePoll, json!({"id": id, "after": 0}))
        .await
        .unwrap();
    assert_eq!(read["events"][0]["data"]["channel"], "news");
    // A secret of the connection never leaves, not even in a message.
    assert_eq!(read["events"][0]["data"]["payload"], "[redacted]");
    let listed = application
        .execute(Operation::RealtimeList, json!({"workspace": "local"}))
        .await
        .unwrap();
    let entry = listed
        .as_array()
        .unwrap()
        .iter()
        .find(|entry| entry["id"] == id)
        .unwrap();
    assert_eq!(entry["protocol"], "redis");
    assert_eq!(entry["url"], "Shop: news, n*");
    let sent = application
        .execute(Operation::RealtimeSend, json!({"id": id, "message": "x"}))
        .await;
    assert!(message(sent).contains("PUBLISH"));
    application
        .execute(Operation::RealtimeClose, json!({"id": id}))
        .await
        .unwrap();
    assert!(sources.disconnected.lock().unwrap().contains(&session));
    let calls = sources.key_values.lock().unwrap();
    assert!(
        calls
            .iter()
            .any(|(_, method, _)| method == "kv.unsubscribe")
    );
}
