//! The schema explorer: a `$sample` (of a filter's documents too) analysed with its
//! schemas, and validation rules applied only as a confirmed write.
use crate::testing::*;

fn sample(extra: Value) -> Value {
    let mut payload = json!({
        "workspace": "local", "id": "schema-1", "database": "shop", "collection": "orders",
        "connection": {"uri": "mongodb://db.test"},
    });
    payload
        .as_object_mut()
        .unwrap()
        .extend(extra.as_object().unwrap().clone());
    payload
}

#[tokio::test]
async fn a_sample_is_analysed_with_its_json_schema_and_validator() {
    let (application, fake) = application();
    let answer = application
        .execute(Operation::MongoSchema, sample(json!({})))
        .await
        .unwrap();
    let request = fake.aggregates.lock().unwrap().remove(0);
    assert_eq!(request.pipeline, [json!({"$sample": {"size": 1000}})]);
    assert_eq!(request.page_size, 1000);
    assert_eq!(answer["sampled"], 1);
    assert_eq!(answer["fields"][0]["path"], "_id");
    assert_eq!(answer["fields"][1]["types"][0]["name"], "Int32");
    assert_eq!(
        answer["validator"]["$jsonSchema"]["properties"]["total"]["bsonType"],
        "int"
    );
    assert_eq!(
        answer["jsonSchema"]["properties"]["total"]["type"],
        "integer"
    );
    assert!(answer["elapsedMs"].is_u64());

    application
        .execute(
            Operation::MongoSchema,
            sample(json!({"size": 50, "filter": {"status": "A"}})),
        )
        .await
        .unwrap();
    let request = fake.aggregates.lock().unwrap().remove(0);
    assert_eq!(
        request.pipeline,
        [
            json!({"$match": {"status": "A"}}),
            json!({"$sample": {"size": 50}})
        ]
    );
    for size in [0, 10_001] {
        let error = application
            .execute(Operation::MongoSchema, sample(json!({ "size": size })))
            .await
            .unwrap_err();
        assert_eq!(
            error.to_string(),
            "A sample has between 1 and 10000 documents"
        );
    }
}

#[tokio::test]
async fn validation_rules_need_a_writable_connection_and_the_name() {
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
    let rules = |connection: &str, confirm: &str, extra: Value| {
        let mut payload = sample(json!({
            "connectionId": connection, "confirm": confirm,
            "validator": {"$jsonSchema": {"bsonType": "object", "required": ["sku"]}},
        }));
        payload
            .as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        payload.as_object_mut().unwrap().remove("id");
        payload
    };
    let error = |result: Result<Value>| result.unwrap_err().to_string();
    assert_eq!(
        error(
            application
                .execute(
                    Operation::MongoCollectionValidator,
                    rules("ro", "orders", json!({}))
                )
                .await
        ),
        "The connection ro is read-only: Nexo refuses its writes"
    );
    assert_eq!(
        error(
            application
                .execute(
                    Operation::MongoCollectionValidator,
                    rules("rw", "other", json!({}))
                )
                .await
        ),
        "Type the name of the collection to confirm: orders"
    );
    assert!(fake.changes.lock().unwrap().is_empty());

    application
        .execute(
            Operation::MongoCollectionValidator,
            rules("rw", "orders", json!({})),
        )
        .await
        .unwrap();
    application
        .execute(
            Operation::MongoCollectionValidator,
            rules(
                "rw",
                "orders",
                json!({"validationLevel": "moderate", "validationAction": "warn"}),
            ),
        )
        .await
        .unwrap();
    let changes = fake.changes.lock().unwrap().clone();
    let levels: Vec<_> = changes
        .iter()
        .map(|change| match change {
            ports::CollectionChange::Validator {
                collection,
                level,
                action,
                validator,
                ..
            } => {
                assert_eq!(collection, "orders");
                assert_eq!(validator["$jsonSchema"]["required"], json!(["sku"]));
                (*level, *action)
            }
            other => panic!("{other:?}"),
        })
        .collect();
    assert_eq!(levels, [("strict", "error"), ("moderate", "warn")]);
}
