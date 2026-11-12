//! Imports: batches to a writable saved connection, an upsert key, and emptying the
//! collection only with its name.
use crate::testing::*;

fn saved(fake: &Fake, id: &str, value: Value) {
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

fn import(connection: &str, extra: Value) -> Value {
    let mut payload = json!({
        "workspace": "local", "connectionId": connection, "database": "shop",
        "collection": "orders", "connection": {"uri": "mongodb://db.test"},
        "documents": [{"sku": "A-1"}, {"sku": "B-2"}],
    });
    payload
        .as_object_mut()
        .unwrap()
        .extend(extra.as_object().unwrap().clone());
    payload
}

#[tokio::test]
async fn imports_reach_a_writable_saved_connection_without_being_recorded() {
    let (application, fake) = application();
    saved(
        &fake,
        "ro",
        json!({"uri": "mongodb://db.test", "readOnly": true}),
    );
    saved(&fake, "rw", json!({"uri": "mongodb://db.test"}));
    let error = |result: Result<Value>| result.unwrap_err().to_string();

    assert_eq!(
        error(
            application
                .execute(Operation::MongoImport, import("ro", json!({})))
                .await
        ),
        "The connection ro is read-only: Nexo refuses its writes"
    );
    let answer = application
        .execute(Operation::MongoImport, import("rw", json!({})))
        .await
        .unwrap();
    assert_eq!(answer["inserted"], 2);
    let (target, batch) = fake.imports.lock().unwrap().remove(0);
    assert_eq!(
        (target.database.as_str(), target.collection.as_str()),
        ("shop", "orders")
    );
    assert_eq!(batch.documents.len(), 2);
    assert_eq!(
        (batch.upsert_key, batch.clear, batch.ordered),
        (None, false, false)
    );
    // Imports are not recorded to undo them, unlike the other writes of documents.
    assert!(
        fake.documents
            .lock()
            .unwrap()
            .iter()
            .all(|d| d.kind != DocumentKind::DatabaseChange)
    );

    assert_eq!(
        error(
            application
                .execute(
                    Operation::MongoImport,
                    import("rw", json!({"mode": "upsert"}))
                )
                .await
        ),
        "Choose the fields that find the document to replace"
    );
    application
        .execute(
            Operation::MongoImport,
            import(
                "rw",
                json!({"mode": "upsert", "key": [" sku ", ""], "ordered": true}),
            ),
        )
        .await
        .unwrap();
    let (_, batch) = fake.imports.lock().unwrap().remove(0);
    assert_eq!(batch.upsert_key, Some(vec!["sku".to_string()]));
    assert!(batch.ordered);

    assert_eq!(
        error(
            application
                .execute(
                    Operation::MongoImport,
                    import("rw", json!({"clearConfirm": "order"}))
                )
                .await
        ),
        "Type the name of the collection to confirm: orders"
    );
    application
        .execute(
            Operation::MongoImport,
            import("rw", json!({"clearConfirm": "orders"})),
        )
        .await
        .unwrap();
    assert!(fake.imports.lock().unwrap().remove(0).1.clear);

    let too_many = vec![json!({}); crate::database::IMPORT_BATCH + 1];
    assert_eq!(
        error(
            application
                .execute(
                    Operation::MongoImport,
                    import("rw", json!({"documents": too_many}))
                )
                .await
        ),
        "Send at most 5000 documents in a batch"
    );
}
