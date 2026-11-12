//! Indexes and the profiler: only through a writable saved connection.
use crate::testing::*;

#[tokio::test]
async fn indexes_and_the_profiler_change_only_through_a_writable_saved_connection() {
    let (application, fake) = application();
    for (id, value) in [
        ("ro", json!({"uri": "mongodb://db.test", "readOnly": true})),
        ("rw", json!({"uri": "mongodb://db.test"})),
    ] {
        fake.documents.lock().unwrap().push(Document {
            id: DocumentId::parse(id).unwrap(),
            workspace_id: WorkspaceId::parse("local").unwrap(),
            kind: DocumentKind::Connection,
            name: id.into(),
            revision: 1,
            updated_at: 0,
            value,
        });
    }
    let run = |operation: Operation, connection: &str, extra: Value| {
        let mut payload = json!({
            "workspace": "local", "connectionId": connection, "database": "shop",
            "connection": {"uri": "mongodb://db.test"},
        });
        payload
            .as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        application.execute(operation, payload)
    };
    for (operation, extra) in [
        (
            Operation::MongoIndexCreate,
            json!({"collection": "orders", "keys": {"at": -1}}),
        ),
        (
            Operation::MongoIndexHide,
            json!({"collection": "orders", "name": "at_-1", "hidden": true}),
        ),
        (
            Operation::MongoIndexDrop,
            json!({"collection": "orders", "name": "at_-1", "confirm": "at_-1"}),
        ),
        (Operation::MongoProfileSet, json!({"level": 2})),
    ] {
        let refused = run(operation, "ro", extra).await.unwrap_err().to_string();
        assert!(refused.contains("read-only"), "{operation}: {refused}");
    }
    let refused = |result: Result<Value>| result.unwrap_err().to_string();
    assert_eq!(
        refused(
            run(
                Operation::MongoIndexDrop,
                "rw",
                json!({"collection": "orders", "name": "at_-1", "confirm": "at_1"})
            )
            .await
        ),
        "Type the name of the index to confirm: at_-1"
    );
    assert!(
        refused(
            run(
                Operation::MongoIndexCreate,
                "rw",
                json!({"collection": "orders", "keys": {}})
            )
            .await
        )
        .contains("at least one field")
    );
    assert!(
        refused(run(Operation::MongoProfileSet, "rw", json!({"level": 3})).await)
            .contains("0 (off), 1 (slow operations) or 2 (all)")
    );
    assert!(
        fake.indexes.lock().unwrap().is_empty(),
        "nothing refused ran"
    );

    run(
        Operation::MongoIndexCreate,
        "rw",
        json!({"collection": "orders", "keys": {"at": -1}, "options": {"unique": true}}),
    )
    .await
    .unwrap();
    run(
        Operation::MongoIndexDrop,
        "rw",
        json!({"collection": "orders", "name": "at_-1", "confirm": " at_-1 "}),
    )
    .await
    .unwrap();
    assert_eq!(
        *fake.indexes.lock().unwrap(),
        vec![
            ports::IndexChange::Create {
                database: "shop".into(),
                collection: "orders".into(),
                keys: json!({"at": -1}),
                options: Some(json!({"unique": true})),
            },
            ports::IndexChange::Drop {
                database: "shop".into(),
                collection: "orders".into(),
                name: "at_-1".into(),
            },
        ]
    );
    let status = run(
        Operation::MongoProfileSet,
        "rw",
        json!({"level": 1, "slowms": 20}),
    )
    .await
    .unwrap();
    assert_eq!(status, json!({"level": 1, "slowms": 20}));
    // Changes of the server are not recorded as changes of documents to undo.
    assert!(
        !fake
            .documents
            .lock()
            .unwrap()
            .iter()
            .any(|d| d.kind == DocumentKind::DatabaseChange)
    );
}
