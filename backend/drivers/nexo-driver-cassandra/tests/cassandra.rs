//! The Cassandra module against the fixture's node (`tools/nosql-fixture.sh`): the battery of
//! conformance in what applies, every type, the catalog with its keys, the rebuilt DDL, bound
//! parameters, and a contact point the egress policy refuses.
mod common;

use common::{Host, driver, driver_with, params, run, run_with};
use nexo_driver_cassandra::CassandraDriver;
use nexo_driver_sdk::{
    Value, ValueKind,
    conformance::{Suite, check},
    protocol::ObjectParams,
};
use std::collections::HashMap;

#[tokio::test]
async fn cassandra_passes_the_conformance_checks() {
    let connect = fixture!(params("conformance"));
    // The columns of the keyspace `system`, which no test changes; how many depends on the
    // version of the server.
    let paged_sql = "SELECT * FROM system_schema.columns WHERE keyspace_name = 'system'";
    let counter = driver();
    counter.connect(&connect).await.unwrap();
    let paged_rows = run(&counter, "conformance", paged_sql)
        .await
        .unwrap()
        .rows
        .len();
    assert!(paged_rows > 100, "{paged_rows}");
    let suite = Suite {
        connect,
        wrong_password: None,
        paged_sql: paged_sql.into(),
        paged_rows,
        slow_sql: None,
        invalid_sql: "SELECT FROM".into(),
        values: vec![
            (
                "SELECT a_text FROM shop.every_type WHERE id = 1".into(),
                Value::Text("O'Brien".into()),
            ),
            (
                "SELECT a_blob FROM shop.every_type WHERE id = 1".into(),
                Value::bytes(&[1, 2]),
            ),
            (
                "SELECT a_text FROM shop.every_type WHERE id = 2".into(),
                Value::Null,
            ),
        ],
        rollback: None,
    };
    let failures = check(CassandraDriver::default(), suite).await;
    assert!(failures.is_empty(), "{failures:#?}");
}

#[tokio::test]
async fn every_type_keeps_its_value() {
    let connect = fixture!(params("types"));
    let client = driver();
    client.connect(&connect).await.unwrap();
    let result = run(
        &client,
        "types",
        "SELECT * FROM shop.every_type WHERE id = 1",
    )
    .await
    .unwrap();
    let row: HashMap<&str, &Value> = result
        .columns
        .iter()
        .map(|c| c.name.as_str())
        .zip(&result.rows[0])
        .collect();
    let typed = |kind, text: &str| Value::typed(kind, text);
    for (column, expected) in [
        ("a_bigint", Value::Integer(9_007_199_254_740_993)),
        (
            "a_varint",
            typed(ValueKind::Integer, "123456789012345678901234567890"),
        ),
        ("a_decimal", typed(ValueKind::Decimal, "1.50")),
        (
            "a_uuid",
            typed(ValueKind::Uuid, "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11"),
        ),
        (
            "a_timestamp",
            typed(ValueKind::Timestamptz, "2024-01-02T03:04:05.006Z"),
        ),
        ("a_date", typed(ValueKind::Date, "2024-01-02")),
        ("a_time", typed(ValueKind::Time, "01:02:03.000000123")),
        ("a_duration", typed(ValueKind::Interval, "1y2mo3d4h")),
        ("an_inet", Value::Text("10.0.0.1".into())),
        (
            "a_list",
            Value::Array(vec![Value::Integer(1), Value::Integer(2)]),
        ),
        ("a_map", typed(ValueKind::Json, "{\"k\":1}")),
        (
            "an_address",
            typed(ValueKind::Json, "{\"city\":\"Lima\",\"zip\":\"15001\"}"),
        ),
        (
            "a_tuple",
            Value::Array(vec![Value::Integer(7), Value::Text("seven".into())]),
        ),
        ("a_boolean", Value::Bool(true)),
        ("a_smallint", Value::Integer(3)),
    ] {
        assert_eq!(row[column], &expected, "{column}");
    }
    // Parameters bound as the statement expects them, a quote never part of it.
    let found = run_with(
        &client,
        "types",
        "SELECT id FROM shop.every_type WHERE id = ?",
        vec![Value::Text("1".into())],
    )
    .await
    .unwrap();
    assert_eq!(found.rows, vec![vec![Value::Integer(1)]]);
    run_with(
        &client,
        "types",
        "INSERT INTO shop.every_type (id, a_text, a_decimal, a_date) VALUES (?, ?, ?, ?)",
        vec![
            Value::Integer(3),
            Value::Text("it's".into()),
            typed(ValueKind::Decimal, "-0.005"),
            Value::Text("2000-02-29".into()),
        ],
    )
    .await
    .unwrap();
    let back = run(
        &client,
        "types",
        "SELECT a_text, a_decimal, a_date FROM shop.every_type WHERE id = 3",
    )
    .await
    .unwrap();
    assert_eq!(
        back.rows[0],
        vec![
            Value::Text("it's".into()),
            typed(ValueKind::Decimal, "-0.005"),
            typed(ValueKind::Date, "2000-02-29")
        ]
    );
    run(&client, "types", "DELETE FROM shop.every_type WHERE id = 3")
        .await
        .unwrap();
}

#[tokio::test]
async fn the_catalog_marks_the_keys_and_the_ddl_rebuilds_the_table() {
    let connect = fixture!(params("catalog"));
    let client = driver();
    client.connect(&connect).await.unwrap();
    let tree = |path: &[&str]| {
        let client = client.clone();
        let path: Vec<String> = path.iter().map(|part| (*part).to_owned()).collect();
        async move {
            client
                .tree(&ObjectParams {
                    connection: "catalog".into(),
                    path,
                })
                .await
                .unwrap()
        }
    };
    let keyspaces = tree(&[]).await;
    let shop = keyspaces.iter().find(|node| node.name == "shop").unwrap();
    assert!(
        shop.detail
            .as_deref()
            .unwrap()
            .contains("SimpleStrategy, 1")
    );
    assert!(
        keyspaces
            .iter()
            .any(|node| node.name == "system_schema" && node.system)
    );
    let tables: Vec<String> = tree(&["shop", "tables"])
        .await
        .into_iter()
        .map(|node| node.name)
        .collect();
    assert!(tables.contains(&"readings".to_owned()));
    let columns = tree(&["shop", "tables", "readings", "columns"]).await;
    let detail: HashMap<String, String> = columns
        .into_iter()
        .map(|node| (node.name, node.detail.unwrap_or_default()))
        .collect();
    assert_eq!(detail["sensor"], "text · partition key 1");
    assert_eq!(detail["day"], "date · partition key 2");
    assert_eq!(detail["at"], "timestamp · clustering 1 (desc)");
    assert_eq!(detail["unit"], "text · static");
    let types: Vec<String> = tree(&["shop", "types"])
        .await
        .into_iter()
        .map(|node| node.name)
        .collect();
    assert_eq!(types, ["address"]);
    let ddl = client
        .ddl(&ObjectParams {
            connection: "catalog".into(),
            path: vec!["shop".into(), "tables".into(), "readings".into()],
        })
        .await
        .unwrap()
        .sql;
    assert!(ddl.contains("PRIMARY KEY ((sensor, day), at)"), "{ddl}");
    assert!(ddl.contains("CLUSTERING ORDER BY (at DESC)"), "{ddl}");
    assert!(ddl.contains("unit text STATIC"), "{ddl}");
    assert!(
        ddl.contains("CREATE INDEX readings_value ON shop.readings (value);"),
        "{ddl}"
    );
    // The rebuilt DDL makes the same table again.
    let copy = ddl
        .replace("shop.readings", "shop.readings_copy")
        .replace("readings_value", "readings_copy_value");
    for statement in copy.split(";\n").filter(|s| !s.trim().is_empty()) {
        run(&client, "catalog", statement).await.unwrap();
    }
    run(&client, "catalog", "DROP TABLE shop.readings_copy")
        .await
        .unwrap();
    let description = client
        .describe(&ObjectParams {
            connection: "catalog".into(),
            path: vec!["shop".into(), "tables".into(), "readings".into()],
        })
        .await
        .unwrap();
    assert_eq!(description.sections[0].rows.len(), 5);
}

#[tokio::test]
async fn a_contact_point_the_policy_refuses_is_never_connected() {
    let connect = fixture!(params("refused"));
    let host = Host::default();
    host.refused
        .lock()
        .unwrap()
        .push(connect.host.clone().unwrap());
    let client = driver_with(host.clone());
    let error = client.connect(&connect).await.unwrap_err();
    assert!(
        error.message.contains("blocked by the egress policy"),
        "{error}"
    );
    assert_eq!(host.asked.lock().unwrap().len(), 1);
}
