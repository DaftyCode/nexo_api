//! Change streams: opened with `mongo.watch`, then read, closed and listed by the realtime
//! operations, which reach the database by the stream's identifier.
use crate::testing::*;

fn watch(extra: Value) -> Value {
    let mut payload = json!({"workspace": "local", "connection": {"uri": "mongodb://db.test"}});
    payload
        .as_object_mut()
        .unwrap()
        .extend(extra.as_object().unwrap().clone());
    payload
}

#[tokio::test]
async fn a_change_stream_is_opened_with_what_it_watches() {
    let (application, fake) = application();
    let answer = application
        .execute(
            Operation::MongoWatch,
            watch(json!({
                "database": " shop ", "collection": "orders",
                "pipeline": [{"$match": {"operationType": "insert"}}],
                "fullDocument": "updateLookup", "fullDocumentBeforeChange": "whenAvailable",
                "resumeAfter": "8263A1",
            })),
        )
        .await
        .unwrap();
    assert_eq!(answer, json!({"id": "mongo-watch-1", "state": "connected"}));
    let request = fake.watches.lock().unwrap().remove(0);
    assert_eq!(request.database.as_deref(), Some("shop"));
    assert_eq!(request.collection.as_deref(), Some("orders"));
    assert_eq!(request.pipeline.len(), 1);
    assert_eq!(request.full_document.as_deref(), Some("updateLookup"));
    assert_eq!(request.resume_after, Some(json!({"_data": "8263A1"})));

    // The whole deployment, and a token given whole.
    application
        .execute(
            Operation::MongoWatch,
            watch(json!({"database": "", "resumeAfter": {"_data": "82"}})),
        )
        .await
        .unwrap();
    let request = fake.watches.lock().unwrap().remove(0);
    assert_eq!((request.database, request.collection), (None, None));
    assert_eq!(request.resume_after, Some(json!({"_data": "82"})));

    let error = |payload| async { application.execute(Operation::MongoWatch, payload).await };
    for (payload, message) in [
        (
            watch(json!({"collection": "orders"})),
            "Choose the database of the collection to watch",
        ),
        (
            watch(json!({"fullDocument": "always"})),
            "fullDocument is one of default, updateLookup, whenAvailable, required",
        ),
        (
            watch(json!({"resumeAfter": 5})),
            "A resume token is the text of its _data, or the token itself",
        ),
    ] {
        assert_eq!(error(payload).await.unwrap_err().to_string(), message);
    }
}

#[tokio::test]
async fn the_realtime_operations_reach_change_streams_by_their_identifier() {
    let (application, fake) = application();
    let poll = application
        .execute(
            Operation::RealtimePoll,
            json!({"workspace": "local", "id": "mongo-watch-1", "after": 4}),
        )
        .await
        .unwrap();
    assert_eq!(poll["events"][0]["sequence"], 5);
    assert_eq!(poll["state"], "connected");
    let closed = application
        .execute(
            Operation::RealtimeClose,
            json!({"workspace": "local", "id": "mongo-watch-1"}),
        )
        .await
        .unwrap();
    assert_eq!(closed, json!({"closed": true}));
    let sent = application
        .execute(
            Operation::RealtimeSend,
            json!({"workspace": "local", "id": "mongo-watch-1", "message": "x"}),
        )
        .await
        .unwrap_err();
    assert!(sent.to_string().contains("only receives"), "{sent}");
    // Other connections stay with the engine, and the list has both.
    application
        .execute(
            Operation::RealtimePoll,
            json!({"workspace": "local", "id": "1234", "after": 0}),
        )
        .await
        .unwrap();
    let list = application
        .execute(Operation::RealtimeList, json!({"workspace": "local"}))
        .await
        .unwrap();
    assert_eq!(
        list,
        json!([{"id": "mongo-watch-1", "protocol": "mongodb", "url": "shop.orders", "state": "connected"}])
    );
    let engine: Vec<String> = fake
        .executed
        .lock()
        .unwrap()
        .iter()
        .map(|(operation, _)| operation.clone())
        .collect();
    assert_eq!(engine, ["realtime.poll", "realtime.list"]);
}
