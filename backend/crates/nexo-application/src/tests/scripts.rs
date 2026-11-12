//! `nx.mongo`: a script names a saved connection and gets the operations of the interface,
//! with their rules, without ever seeing the connection's URI or password.
use crate::testing::*;
use ports::{ScriptCall, ScriptDatabase};

fn saved(fake: &Fake, id: &str, name: &str, value: Value) {
    fake.documents.lock().unwrap().push(Document {
        id: DocumentId::parse(id).unwrap(),
        workspace_id: WorkspaceId::parse("local").unwrap(),
        kind: DocumentKind::Connection,
        name: name.into(),
        revision: 1,
        updated_at: 0,
        value,
    });
}

fn call(connection: &str, method: &str, arguments: Value) -> ScriptCall {
    ScriptCall {
        workspace: "local".into(),
        connection: connection.into(),
        variables: json!({"host": "db.test", "other": "x"})
            .as_object()
            .unwrap()
            .clone(),
        database: "shop".into(),
        collection: "orders".into(),
        method: method.into(),
        arguments: arguments.as_array().unwrap().clone(),
        confirm: None,
    }
}

fn application_with_connections() -> (Application, Arc<Fake>) {
    let (application, fake) = application();
    saved(
        &fake,
        "c1",
        "Local",
        json!({"uri": "mongodb://{{host}}:27017", "password": "{{vault:mongo}}", "color": "red"}),
    );
    saved(
        &fake,
        "c2",
        "Production",
        json!({"uri": "mongodb://prod.test", "readOnly": true}),
    );
    (application, fake)
}

#[tokio::test]
async fn reads_go_to_the_connection_named_with_its_variables_and_vault_secret() {
    let (application, fake) = application_with_connections();
    let found = application
        .script_call(call(
            "Local",
            "find",
            json!([{"status": "A"}, {"sort": {"at": -1}, "limit": 5000, "skip": 2}]),
        ))
        .await
        .unwrap();
    assert_eq!(found.as_array().unwrap().len(), 1);
    let request = fake.finds.lock().unwrap().remove(0);
    assert_eq!(request.filter, Some(json!({"status": "A"})));
    assert_eq!(request.sort, Some(json!({"at": -1})));
    assert_eq!(
        (request.limit, request.skip, request.page_size),
        (Some(1000), Some(2), 1000)
    );

    let one = application
        .script_call(call("Local", "findOne", json!([{}])))
        .await
        .unwrap();
    assert_eq!(one["_id"]["$oid"], "65a1b2c3d4e5f6a7b8c9d0e1");
    assert_eq!(fake.finds.lock().unwrap().remove(0).limit, Some(1));
    let counted = application
        .script_call(call("Local", "countDocuments", json!([{"status": "A"}])))
        .await
        .unwrap();
    assert_eq!(counted, 7);
    let aggregated = application
        .script_call(call(
            "Local",
            "aggregate",
            json!([[{"$group": {"_id": "$b"}}], {"allowDiskUse": true, "comment": "x"}]),
        ))
        .await
        .unwrap();
    assert_eq!(aggregated[0]["_id"], "A");
    let request = fake.aggregates.lock().unwrap().remove(0);
    assert!(request.options.allow_disk_use);
    assert_eq!(request.page_size, 1000);
    // The URI with the script's variables, the password from the vault; neither goes back.
    let connection = fake.connections.lock().unwrap().remove(0);
    assert_eq!(connection.uri, "mongodb://db.test:27017");
    assert_eq!(connection.password.as_deref(), Some("secret-of-mongo"));
}

#[tokio::test]
async fn writes_keep_the_rules_of_the_interface() {
    let (application, fake) = application_with_connections();
    let error = |result: Result<Value>| result.unwrap_err().to_string();
    assert_eq!(
        error(
            application
                .script_call(call("Production", "insertOne", json!([{"sku": "A"}])))
                .await
        ),
        "The connection Production is read-only: Nexo refuses its writes"
    );
    assert_eq!(
        error(
            application
                .script_call(call("Missing", "findOne", json!([])))
                .await
        ),
        "No saved MongoDB connection is named Missing"
    );
    assert_eq!(
        error(
            application
                .script_call(call("Local", "rename", json!([])))
                .await
        ),
        "nx.mongo collections have no method rename"
    );
    assert!(fake.writes.lock().unwrap().is_empty());

    let inserted = application
        .script_call(call("Local", "insertOne", json!([{"sku": "A"}])))
        .await
        .unwrap();
    assert_eq!(inserted["acknowledged"], true);
    // A write to many documents carries the count it found, as the interface confirms it.
    let updated = application
        .script_call(call(
            "Local",
            "updateMany",
            json!([{"status": "A"}, {"$set": {"status": "B"}}]),
        ))
        .await
        .unwrap();
    assert_eq!(updated["matchedCount"], 1);
    let writes = fake.writes.lock().unwrap().clone();
    match &writes[1].1 {
        ports::DocumentWrite::Update { many, expected, .. } => {
            assert!(*many);
            assert_eq!(*expected, Some(7));
        }
        other => panic!("{other:?}"),
    }
    // Emptying the collection needs its name.
    assert_eq!(
        error(
            application
                .script_call(call("Local", "deleteMany", json!([{}])))
                .await
        ),
        "Type the name of the collection to confirm: orders"
    );
    application
        .script_call(call(
            "Local",
            "deleteMany",
            json!([{}, {"confirm": "orders"}]),
        ))
        .await
        .unwrap();
    // Every write is recorded to undo it, like those of the interface.
    let changes = fake
        .documents
        .lock()
        .unwrap()
        .iter()
        .filter(|d| d.kind == DocumentKind::DatabaseChange)
        .count();
    assert_eq!(changes, 3);
}
