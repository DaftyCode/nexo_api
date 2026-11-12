//! Writes to documents: who may write, what is recorded and undone.
use crate::testing::*;

#[tokio::test]
async fn writes_are_refused_on_read_only_and_other_connections_and_recorded() {
    let (application, fake) = application();
    let saved = |id: &str, value: Value| {
        fake.documents.lock().unwrap().push(Document {
            id: DocumentId::parse(id).unwrap(),
            workspace_id: WorkspaceId::parse("local").unwrap(),
            kind: DocumentKind::Connection,
            name: id.into(),
            revision: 1,
            updated_at: 0,
            value,
        })
    };
    saved("ro", json!({"uri": "mongodb://{{host}}", "readOnly": true}));
    saved(
        "rw",
        json!({"uri": "mongodb://{{host}}", "password": "{{vault:p}}"}),
    );
    let write = |operation: Operation, extra: Value| {
        let mut payload = json!({
            "workspace": "local", "connectionId": "rw", "database": "shop",
            "collection": "orders",
            "connection": {"uri": "mongodb://db.test", "password": "{{vault:p}}"},
        });
        for (key, value) in extra.as_object().unwrap() {
            if value.is_null() {
                payload.as_object_mut().unwrap().remove(key);
            } else {
                payload[key] = value.clone();
            }
        }
        application.execute(operation, payload)
    };
    let error = |result: Result<Value>| result.unwrap_err().to_string();
    assert_eq!(
        error(
            write(
                Operation::MongoInsert,
                json!({"connectionId": "ro", "connection": {"uri": "mongodb://db.test"},
                    "documents": [{}]})
            )
            .await
        ),
        "The connection ro is read-only: Nexo refuses its writes"
    );
    for (refused, extra) in [
        (Operation::MongoCollectionCreate, json!({})),
        (Operation::MongoCollectionRename, json!({"to": "x"})),
        (Operation::MongoCollectionDrop, json!({"confirm": "orders"})),
    ] {
        let mut payload = json!({"connectionId": "ro", "connection": {"uri": "mongodb://db.test"}});
        payload
            .as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        let result = write(refused, payload).await;
        assert!(error(result).contains("read-only"), "{refused}");
    }
    assert!(
        error(
            write(
                Operation::MongoInsert,
                json!({"connection": {"uri": "mongodb+srv://db.test",
                    "password": "{{vault:p}}"}, "documents": [{}]})
            )
            .await
        )
        .contains("not the saved one")
    );
    assert!(
        error(
            write(
                Operation::MongoUpdate,
                json!({"filter": {}, "update": {"$set": {"a": 1}}, "many": true})
            )
            .await
        )
        .starts_with("Count the documents first")
    );
    assert_eq!(
        error(
            write(
                Operation::MongoDelete,
                json!({"filter": {}, "many": true, "expected": 3})
            )
            .await
        ),
        "Type the name of the collection to confirm: orders"
    );
    assert!(
        error(
            write(
                Operation::MongoDatabaseDrop,
                json!({"confirm": "orders", "collection": null})
            )
            .await
        )
        .contains("database to confirm: shop")
    );
    assert!(
        application
            .execute(
                Operation::MongoInsert,
                json!({"connectionId": "rw", "database": "d", "collection": "c",
                    "connection": {"uri": "mongodb://db.test"}, "documents": []}),
            )
            .await
            .unwrap_err()
            .to_string()
            .contains("Choose a workspace")
    );
    assert!(
        fake.writes.lock().unwrap().is_empty(),
        "nothing refused was written"
    );

    // A write is recorded with its documents, and undone from the record.
    let done = write(
        Operation::MongoUpdate,
        json!({"filter": {"_id": 1}, "update": {"$set": {"n": 2}}}),
    )
    .await
    .unwrap();
    assert_eq!(
        (done["matched"].clone(), done["modified"].clone()),
        (json!(1), json!(1))
    );
    let change = done["change"].as_str().unwrap().to_string();
    let recorded = fake
        .documents
        .lock()
        .unwrap()
        .iter()
        .find(|d| d.id.as_str() == change)
        .cloned()
        .unwrap();
    assert_eq!(recorded.kind, DocumentKind::DatabaseChange);
    assert_eq!(recorded.value["operation"], "mongo.update");
    assert_eq!(
        recorded.value["changes"][0]["before"]["n"]["$numberInt"],
        "1"
    );
    assert!(!recorded.value.to_string().contains("secret-of-p"));
    assert_eq!(
        fake.connections
            .lock()
            .unwrap()
            .last()
            .unwrap()
            .password
            .as_deref(),
        Some("secret-of-p")
    );
    let undone = write(
        Operation::MongoUndo,
        json!({"change": change, "database": null, "collection": null}),
    )
    .await
    .unwrap();
    assert_eq!(undone["matched"], 1);
    let (_, last) = fake.writes.lock().unwrap().last().cloned().unwrap();
    assert!(matches!(last, ports::DocumentWrite::Restore { ref changes } if changes.len() == 1));
    assert!(
        error(
            write(
                Operation::MongoUndo,
                json!({"change": "rw", "database": null, "collection": null})
            )
            .await
        )
        .contains("not one of this connection")
    );
}
