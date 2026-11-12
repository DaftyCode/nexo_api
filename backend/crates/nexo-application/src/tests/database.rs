//! Database reads: connections, queries and explain.
use crate::testing::*;

#[tokio::test]
async fn database_connections_get_their_secrets_but_never_return_them() {
    let (application, fake) = application();
    let missing = application
        .execute(
            Operation::MongoTest,
            json!({"connection": {"uri": "mongodb://db.test", "password": "{{vault:deleted}}"}}),
        )
        .await;
    assert!(
        missing
            .unwrap_err()
            .to_string()
            .contains("Secret not found")
    );
    let report = application
        .execute(
            Operation::MongoTest,
            json!({"connection": {
                "uri": "mongodb://{{vault:user}}@db.test/?authSource=admin",
                "password": "{{vault:pass}}",
                "keyPem": "{{ vault:key }}",
            }}),
        )
        .await
        .unwrap();
    assert_eq!(report["serverVersion"], "8.0.4");
    assert!(report.get("replicaSet").is_none());
    let connection = fake.connections.lock().unwrap()[0].clone();
    // The fake vault answers `secret-of-<name>`.
    assert_eq!(
        connection.uri,
        "mongodb://secret-of-user@db.test/?authSource=admin"
    );
    assert_eq!(connection.password.as_deref(), Some("secret-of-pass"));
    assert_eq!(connection.key_pem.as_deref(), Some("secret-of-key"));
    assert!(!format!("{connection:?}").contains("secret-of-pass"));
    assert!(!format!("{connection:?}").contains("secret-of-key"));

    let error = application
        .execute(
            Operation::MongoTest,
            json!({"connection": {"uri": "mongodb://fail@db.test", "password": "{{vault:p@ss}}"}}),
        )
        .await
        .unwrap_err()
        .to_string();
    assert_eq!(
        error,
        "Authentication failed for password [redacted] ([redacted])"
    );
}

#[tokio::test]
async fn queries_reach_the_database_with_their_documents_and_defaults() {
    let (application, fake) = application();
    let connection = json!({"uri": "mongodb://ana@db.test", "password": "{{vault:pass}}"});
    let databases = application
        .execute(
            Operation::MongoDatabases,
            json!({"connection": connection.clone()}),
        )
        .await
        .unwrap();
    assert_eq!(
        databases,
        json!({"databases": [{"name": "shop", "sizeOnDisk": 4096, "empty": false}]})
    );
    let collections = application
        .execute(
            Operation::MongoCollections,
            json!({"connection": connection.clone(), "database": "shop"}),
        )
        .await
        .unwrap();
    assert_eq!(collections["collections"][0]["name"], "shop-orders");
    let page = application
        .execute(
            Operation::MongoFind,
            json!({"connection": connection.clone(), "id": "q1", "database": "shop",
                "collection": "orders", "filter": {"status": "A"}, "limit": 0}),
        )
        .await
        .unwrap();
    assert_eq!(page["cursor"], "c1");
    assert_eq!(
        page["documents"][0]["_id"]["$oid"],
        "65a1b2c3d4e5f6a7b8c9d0e1"
    );
    let request = fake.finds.lock().unwrap()[0].clone();
    assert_eq!(request.filter, Some(json!({"status": "A"})));
    assert_eq!(request.limit, None, "a limit of 0 means every document");
    assert_eq!(request.page_size, DATABASE_PAGE);
    let count = application
        .execute(
            Operation::MongoCount,
            json!({"connection": connection.clone(), "id": "q2", "database": "shop",
                "collection": "orders", "limit": 3}),
        )
        .await
        .unwrap();
    assert_eq!(count, json!({"count": 3}));
    let cancelled = application
        .execute(Operation::MongoCancel, json!({"id": "running"}))
        .await
        .unwrap();
    assert_eq!(cancelled, json!({"cancelled": true}));
    let error = application
        .execute(Operation::MongoMore, json!({"cursor": "gone", "id": "q3"}))
        .await
        .unwrap_err();
    assert_eq!(error.to_string(), "Cursor gone closed");
    // The vault values of the connection never come back in an error.
    let error = application
        .execute(
            Operation::MongoFind,
            json!({"connection": {"uri": "mongodb://fail@db.test", "password": "{{vault:pass}}"},
                "id": "q4", "database": "shop", "collection": "orders"}),
        )
        .await
        .unwrap_err();
    assert_eq!(error.to_string(), "Query failed for [redacted]");
}

#[tokio::test]
async fn explains_finds_and_pipelines_and_reads_the_profiler() {
    let (application, fake) = application();
    let connection = json!({"uri": "mongodb://db.test"});
    let explain = application
        .execute(
            Operation::MongoExplain,
            json!({"connection": connection, "id": "e1", "database": "shop",
                "collection": "orders", "filter": {"a": 1}, "limit": 0}),
        )
        .await
        .unwrap();
    assert_eq!(
        explain["explain"]["queryPlanner"]["winningPlan"]["stage"],
        "COLLSCAN"
    );
    application
        .execute(
            Operation::MongoExplain,
            json!({"connection": connection, "id": "e2", "database": "shop",
                "collection": "orders", "verbosity": "executionStats",
                "pipeline": [{"$match": {"a": 1}}, {"$group": {"_id": "$b"}}]}),
        )
        .await
        .unwrap();
    let explains = fake.explains.lock().unwrap().clone();
    assert!(!explains[0].execution_stats, "queryPlanner by default");
    assert!(matches!(
        &explains[0].explained,
        ports::Explained::Find(find) if find.filter == Some(json!({"a": 1})) && find.limit.is_none()
    ));
    assert!(explains[1].execution_stats);
    assert!(matches!(
        &explains[1].explained,
        ports::Explained::Aggregate { pipeline, .. } if pipeline.len() == 2
    ));

    let profile = application
        .execute(
            Operation::MongoProfile,
            json!({"connection": connection, "database": "shop"}),
        )
        .await
        .unwrap();
    assert_eq!(profile, json!({"level": 0, "slowms": 100}));
    let entries = application
        .execute(
            Operation::MongoProfileEntries,
            json!({"connection": connection, "database": "shop", "collection": "",
                "limit": 5000}),
        )
        .await
        .unwrap();
    // At most 100 entries, and an empty collection is the whole database.
    assert_eq!(entries["entries"][0]["millis"], 100);
    assert_eq!(entries["entries"][0]["ns"], "shop.orders");
    let indexes = application
        .execute(
            Operation::MongoIndexes,
            json!({"connection": connection, "database": "shop", "collection": "orders"}),
        )
        .await
        .unwrap();
    assert_eq!(indexes["indexes"][0]["name"], "orders_id_");
}
