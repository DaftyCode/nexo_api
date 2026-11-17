//! The administration of a server: its sessions and locks read on a session, and ending a
//! session refused on read-only connections and confirmed, with the id typed on production.
use super::*;

#[tokio::test]
async fn sessions_and_locks_are_read_on_the_session_that_asks() {
    let (application, _, sources) = with_sources(json!({"readOnly": true}));
    connect(&application, "tree:c1").await.unwrap();
    let asking = json!({"session": "tree:c1", "statement": "admin-1"});
    let sessions = application
        .execute(Operation::DbSessions, asking.clone())
        .await
        .unwrap();
    assert_eq!(sessions["sessions"][0]["own"], true);
    let locks = application
        .execute(Operation::DbLocks, asking)
        .await
        .unwrap();
    assert_eq!(locks["waits"][0]["blocking"], "8");
    let asked = sources.administered.lock().unwrap().clone();
    assert_eq!(
        asked[0],
        (
            "tree:c1".to_string(),
            json!({"connection": "tree:c1", "statement": "admin-1"})
        )
    );
    let unknown = application
        .execute(
            Operation::DbSessions,
            json!({"session": "other", "statement": "s"}),
        )
        .await;
    assert!(message(unknown).contains("not open"));
}

#[tokio::test]
async fn a_read_only_connection_ends_no_session_and_every_end_is_confirmed() {
    let kill = |extra: Value| {
        let mut payload = json!({"session": "tree:c1", "statement": "admin-2", "target": "42", "mode": "terminate"});
        if let (Value::Object(base), Value::Object(extra)) = (&mut payload, extra) {
            base.extend(extra);
        }
        payload
    };
    let (application, _, sources) = with_sources(json!({"readOnly": true}));
    connect(&application, "tree:c1").await.unwrap();
    let refused = application
        .execute(Operation::DbSessionKill, kill(json!({"confirm": true})))
        .await;
    assert!(message(refused).contains("read-only"));
    assert!(sources.administered.lock().unwrap().is_empty());

    let (application, _, sources) = with_sources(json!({}));
    connect(&application, "tree:c1").await.unwrap();
    let unconfirmed = application
        .execute(Operation::DbSessionKill, kill(json!({})))
        .await;
    assert!(message(unconfirmed).contains("Confirm that you want to end the session 42"));
    for (wrong, says) in [
        (
            json!({"mode": "pause", "confirm": true}),
            "neither cancel nor terminate",
        ),
        (
            json!({"target": "42; DROP TABLE t", "confirm": true}),
            "not the id",
        ),
    ] {
        let answer = application
            .execute(Operation::DbSessionKill, kill(wrong))
            .await;
        assert!(message(answer).contains(says), "{says}");
    }
    let done = application
        .execute(
            Operation::DbSessionKill,
            kill(json!({"mode": "cancel", "confirm": true, "target": " 42 "})),
        )
        .await
        .unwrap();
    assert_eq!(done["done"], true);
    let (_, request) = sources.administered.lock().unwrap()[0].clone();
    assert_eq!(
        request,
        json!({"connection": "tree:c1", "statement": "admin-2", "session": "42", "mode": "cancel"})
    );
}

#[tokio::test]
async fn on_production_the_id_of_the_session_is_typed() {
    let (application, _, sources) = with_sources(json!({"type": "production"}));
    connect(&application, "tree:c1").await.unwrap();
    let payload = json!({"session": "tree:c1", "statement": "s", "target": "42", "mode": "terminate", "confirm": true});
    let untyped = application
        .execute(Operation::DbSessionKill, payload.clone())
        .await;
    assert!(message(untyped).contains("type 42 to end that session"));
    let mut typed = payload;
    typed["confirmName"] = json!("42");
    application
        .execute(Operation::DbSessionKill, typed)
        .await
        .unwrap();
    assert_eq!(sources.administered.lock().unwrap().len(), 1);
}
