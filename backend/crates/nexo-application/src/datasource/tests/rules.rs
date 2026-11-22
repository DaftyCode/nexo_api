//! What every statement must get past: read-only and production connections, every row,
//! TRUNCATE and DROP.
use super::*;

#[tokio::test]
async fn a_read_only_connection_runs_only_reads() {
    let (application, _, sources) = with_sources(json!({"readOnly": true}));
    connect(&application, "s1").await.unwrap();
    assert!(sources.connected.lock().unwrap()[0].1.read_only);
    run(&application, "select * from orders", json!({}))
        .await
        .unwrap();
    run(&application, "begin", json!({})).await.unwrap();
    for sql in [
        "insert into orders values (1)",
        "select 1; delete from orders where id = 1",
        "set transaction read write",
        "drop table orders",
    ] {
        let error = message(
            run(
                &application,
                sql,
                json!({"confirm": true, "confirmName": "orders"}),
            )
            .await,
        );
        assert!(error.contains("is read-only"), "{sql}: {error}");
    }
    // Only the two reads reached the driver.
    assert_eq!(sources.executed.lock().unwrap().len(), 2);
}

#[tokio::test]
async fn production_asks_before_every_write_and_everyone_before_every_row() {
    let (application, _, sources) = with_sources(json!({"type": "production"}));
    connect(&application, "s1").await.unwrap();
    run(&application, "select 1", json!({})).await.unwrap();
    let error = message(run(&application, "insert into orders values (1)", json!({})).await);
    assert!(error.contains("asks to confirm each change"), "{error}");
    run(
        &application,
        "insert into orders values (1)",
        json!({"confirm": true}),
    )
    .await
    .unwrap();

    let (application, _, _) = with_sources(json!({}));
    connect(&application, "s1").await.unwrap();
    run(&application, "insert into orders values (1)", json!({}))
        .await
        .unwrap();
    for sql in [
        "delete from orders",
        "update orders set total = 0",
        "truncate orders",
    ] {
        let error = message(run(&application, sql, json!({})).await);
        assert!(error.contains("every row"), "{sql}: {error}");
        run(&application, sql, json!({"confirm": true}))
            .await
            .unwrap();
    }
    let error = message(
        run(
            &application,
            "drop table shop.orders",
            json!({"confirm": true}),
        )
        .await,
    );
    assert_eq!(error, "Type the name of what is dropped to confirm: orders");
    run(
        &application,
        "drop table shop.orders",
        json!({"confirmName": "orders"}),
    )
    .await
    .unwrap();
    assert_eq!(sources.executed.lock().unwrap().len(), 2);
}

#[tokio::test]
async fn allow_filtering_on_cassandra_asks_first_and_a_batch_is_a_write() {
    let (application, _, sources) = with_sources(json!({"driver": "cassandra", "port": 9042}));
    connect(&application, "s1").await.unwrap();
    let sql = "SELECT * FROM shop.readings WHERE value > 2 ALLOW FILTERING";
    let error = message(run(&application, sql, json!({})).await);
    assert!(error.contains("ALLOW FILTERING"), "{error}");
    run(&application, sql, json!({"confirm": true}))
        .await
        .unwrap();
    // CQL has no transactions: a batch is refused on a read-only connection as a write.
    let (application, _, _) = with_sources(json!({"driver": "cassandra", "readOnly": true}));
    connect(&application, "s1").await.unwrap();
    let batch = "BEGIN BATCH INSERT INTO t (k) VALUES (1); APPLY BATCH";
    let error = message(run(&application, batch, json!({})).await);
    assert!(error.contains("is read-only"), "{error}");
    run(&application, "CONSISTENCY QUORUM", json!({}))
        .await
        .unwrap();
    assert_eq!(sources.executed.lock().unwrap().len(), 1);
}
