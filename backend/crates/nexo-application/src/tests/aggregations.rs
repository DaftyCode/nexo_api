//! Aggregations: those that read never carry `$out` or `$merge`; those that write need a
//! writable saved connection, the writing stage last and the name of what they write.
use crate::database::written;
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

fn payload(pipeline: Value, extra: Value) -> Value {
    let mut payload = json!({
        "workspace": "local", "id": "agg-1", "database": "shop", "collection": "orders",
        "connection": {"uri": "mongodb://db.test"}, "pipeline": pipeline,
    });
    payload
        .as_object_mut()
        .unwrap()
        .extend(extra.as_object().unwrap().clone());
    payload
}

fn error(result: Result<Value>) -> String {
    result.unwrap_err().to_string()
}

#[tokio::test]
async fn reading_aggregations_refuse_the_stages_that_write() {
    let (application, fake) = application();
    let answer = application
        .execute(
            Operation::MongoAggregate,
            payload(
                json!([{"$match": {"a": 1}}, {"$group": {"_id": "$b"}}]),
                json!({"allowDiskUse": true, "maxTimeMS": 0, "hint": "a_1", "pageSize": 20}),
            ),
        )
        .await
        .unwrap();
    assert_eq!(answer["documents"][0]["_id"], "A");
    let request = fake.aggregates.lock().unwrap().remove(0);
    assert_eq!(request.pipeline.len(), 2);
    assert!(request.options.allow_disk_use);
    assert_eq!(request.options.max_time_ms, None, "0 is the default limit");
    assert_eq!(request.options.hint, Some(json!("a_1")));
    assert_eq!(request.page_size, 20);

    for stage in [json!({"$out": "copy"}), json!({"$merge": {"into": "copy"}})] {
        let refused = error(
            application
                .execute(
                    Operation::MongoAggregate,
                    payload(json!([{"$match": {}}, stage]), json!({})),
                )
                .await,
        );
        assert!(refused.contains("writes: run it as a write"), "{refused}");
    }
    assert_eq!(
        error(
            application
                .execute(Operation::MongoAggregate, payload(json!([]), json!({})))
                .await
        ),
        "Add at least one stage"
    );
    assert!(fake.aggregates.lock().unwrap().is_empty());
}

#[tokio::test]
async fn writing_aggregations_need_a_writable_connection_and_the_name_written() {
    let (application, fake) = application();
    saved(
        &fake,
        "ro",
        json!({"uri": "mongodb://db.test", "readOnly": true}),
    );
    saved(&fake, "rw", json!({"uri": "mongodb://db.test"}));
    let write = |connection: &str, pipeline: Value, confirm: &str| {
        payload(
            pipeline,
            json!({"connectionId": connection, "confirm": confirm}),
        )
    };
    let out = json!([{"$group": {"_id": "$status"}}, {"$out": "summary"}]);

    assert_eq!(
        error(
            application
                .execute(
                    Operation::MongoAggregateWrite,
                    write("ro", out.clone(), "summary")
                )
                .await
        ),
        "The connection ro is read-only: Nexo refuses its writes"
    );
    assert_eq!(
        error(
            application
                .execute(
                    Operation::MongoAggregateWrite,
                    write("rw", out.clone(), "orders")
                )
                .await
        ),
        "Type the name of the collection to confirm: summary"
    );
    assert_eq!(
        error(
            application
                .execute(
                    Operation::MongoAggregateWrite,
                    write("rw", json!([{"$match": {}}]), "orders")
                )
                .await
        ),
        "Only a pipeline that ends in $out or $merge runs as a write"
    );
    assert_eq!(
        error(
            application
                .execute(
                    Operation::MongoAggregateWrite,
                    write("rw", json!([{"$out": "a"}, {"$out": "b"}]), "b")
                )
                .await
        ),
        "$out can only be the last stage"
    );
    assert!(fake.aggregate_writes.lock().unwrap().is_empty());

    let answer = application
        .execute(
            Operation::MongoAggregateWrite,
            write("rw", out, " summary "),
        )
        .await
        .unwrap();
    assert_eq!(
        answer,
        json!({"database": "shop", "collection": "summary", "elapsedMs": 5})
    );
    let request = fake.aggregate_writes.lock().unwrap().remove(0);
    assert_eq!(
        (request.database.as_str(), request.collection.as_str()),
        ("shop", "orders")
    );
    assert_eq!(request.pipeline.len(), 2);
}

#[test]
fn the_collection_written_is_read_from_out_and_merge() {
    let cases = [
        (json!({"$out": "copy"}), ("shop", "copy")),
        (
            json!({"$out": {"db": "other", "coll": "copy"}}),
            ("other", "copy"),
        ),
        (json!({"$merge": "copy"}), ("shop", "copy")),
        (
            json!({"$merge": {"into": "copy", "on": "_id"}}),
            ("shop", "copy"),
        ),
        (
            json!({"$merge": {"into": {"db": "other", "coll": "copy"}}}),
            ("other", "copy"),
        ),
    ];
    for (stage, (database, collection)) in cases {
        assert_eq!(
            written(&stage, "shop").unwrap(),
            (database.to_string(), collection.to_string()),
            "{stage}"
        );
    }
    for stage in [
        json!({"$out": ""}),
        json!({"$out": {"db": "other"}}),
        json!({"$merge": {"on": "_id"}}),
        json!({"$out": 1}),
    ] {
        assert!(written(&stage, "shop").is_err(), "{stage}");
    }
}
