//! The Ignite module against the fixture's open Ignite 3 node (`tools/nosql-fixture.sh`): the
//! conformance checks, Ignite's types kept, parameters, and the tree, a sheet and a DDL rebuilt
//! from the system views. Pages, sessions and TLS are in `sessions.rs`.
mod common;

use common::{SLOW, driver, params, run};
use nexo_driver_ignite::IgniteDriver;
use nexo_driver_sdk::{
    Value, ValueKind,
    conformance::{Suite, check},
    protocol::ObjectParams,
};

#[tokio::test]
async fn ignite_passes_the_conformance_checks() {
    let connect = fixture!(params("conformance"));
    let client = driver();
    client.connect(&connect).await.unwrap();
    client
        .execute(&run(
            "conformance",
            "CREATE TABLE IF NOT EXISTS PUBLIC.NEXO_CONFORMANCE (ID BIGINT PRIMARY KEY)",
        ))
        .await
        .unwrap();
    let id = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos() as i64;
    let suite = Suite {
        connect,
        // The open node has no authentication: the secure one refuses a wrong password.
        wrong_password: None,
        paged_sql: "SELECT x FROM TABLE(SYSTEM_RANGE(1, 1201)) ORDER BY x".into(),
        paged_rows: 1201,
        slow_sql: Some(SLOW.into()),
        invalid_sql: "SELECT FROM".into(),
        values: vec![
            (
                "SELECT 'O''Brien' AS t".into(),
                Value::Text("O'Brien".into()),
            ),
            ("SELECT CAST(NULL AS VARCHAR) AS t".into(), Value::Null),
            ("SELECT CAST(7 AS BIGINT) AS t".into(), Value::Integer(7)),
        ],
        rollback: Some((
            format!("INSERT INTO PUBLIC.NEXO_CONFORMANCE (ID) VALUES ({id})"),
            "SELECT COUNT(*) FROM PUBLIC.NEXO_CONFORMANCE".into(),
        )),
    };
    let failures = check(IgniteDriver::default(), suite).await;
    assert!(failures.is_empty(), "{failures:#?}");
}

#[tokio::test]
async fn ignite_types_are_kept_and_parameters_bound() {
    let connect = fixture!(params("types"));
    let client = driver();
    client.connect(&connect).await.unwrap();
    let typed = client
        .execute(&run(
            "types",
            "SELECT ID, REGION, PRICE, STOCK, ACTIVE, ADDED, OPENS, UPDATED, SEEN, CODE, PHOTO, \
             RATING, SCORE, SMALL, TINY FROM SHOP.ITEMS WHERE ID = 2",
        ))
        .await
        .unwrap();
    let kinds: Vec<_> = typed.columns.iter().map(|column| column.kind).collect();
    use ValueKind::*;
    assert_eq!(
        kinds,
        [
            Integer,
            Text,
            Decimal,
            Integer,
            Boolean,
            Date,
            Time,
            Timestamp,
            Timestamptz,
            Uuid,
            Binary,
            Float,
            Float,
            Integer,
            Integer
        ]
    );
    assert_eq!(typed.columns[2].type_name, "DECIMAL(10, 2)");
    assert_eq!(typed.columns[1].type_name, "VARCHAR(20)");
    let origin = typed.columns[0].origin.clone().unwrap();
    assert_eq!(
        (origin.table.as_str(), origin.column.as_str()),
        ("ITEMS", "ID")
    );
    let row = &typed.rows[0];
    assert_eq!(row[0], Value::Integer(2));
    assert_eq!(row[2], Value::typed(Decimal, "0.02"));
    assert_eq!(row[5], Value::typed(Date, "2024-01-03"));
    assert_eq!(row[6], Value::typed(Time, "08:30:00.125"));
    assert_eq!(row[8], Value::typed(Timestamptz, "2024-01-02T03:04:05Z"));
    assert_eq!(row[10], Value::bytes(&[0xca, 0xfe]));
    assert_eq!(row[11], Value::Float(0.5));
    assert_eq!(row[14], Value::Integer(-3));
    let mut bound = run(
        "types",
        "SELECT ? + 1, CAST(? AS DECIMAL(10, 2)), ?, ?, ? FROM (VALUES (1))",
    );
    bound.params = vec![
        Value::Integer(41),
        Value::typed(Decimal, "12.50"),
        Value::typed(Date, "2024-02-29"),
        Value::typed(Uuid, "00112233-4455-6677-8899-aabbccddeeff"),
        Value::Text("hola".into()),
    ];
    let answer = client.execute(&bound).await.unwrap();
    let row = &answer.rows[0];
    assert_eq!(row[0], Value::Integer(42));
    assert_eq!(row[1], Value::typed(Decimal, "12.50"));
    assert_eq!(row[2], Value::typed(Date, "2024-02-29"));
    assert_eq!(
        row[3],
        Value::typed(Uuid, "00112233-4455-6677-8899-aabbccddeeff")
    );
    assert_eq!(row[4], Value::Text("hola".into()));
}

#[tokio::test]
async fn the_tree_sheet_and_ddl_come_from_the_system_views() {
    let connect = fixture!(params("tree"));
    let client = driver();
    client.connect(&connect).await.unwrap();
    let at = |path: &[&str]| ObjectParams {
        connection: "tree".into(),
        path: path.iter().map(|part| (*part).to_owned()).collect(),
    };
    let schemas = client.tree(&at(&[])).await.unwrap();
    let names: Vec<_> = schemas.iter().map(|node| node.name.as_str()).collect();
    assert!(
        names.contains(&"SHOP") && names.contains(&"SYSTEM"),
        "{names:?}"
    );
    assert!(
        schemas
            .iter()
            .find(|node| node.name == "SYSTEM")
            .unwrap()
            .system
    );
    let tables = client.tree(&at(&["SHOP"])).await.unwrap();
    let items = tables.iter().find(|node| node.name == "ITEMS").unwrap();
    assert_eq!(items.detail.as_deref(), Some("SHOP_ZONE"));
    let views = client.tree(&at(&["SYSTEM"])).await.unwrap();
    assert!(
        views
            .iter()
            .any(|node| node.name == "SQL_QUERIES" && node.kind == "view")
    );
    let columns = client.tree(&at(&["SHOP", "ITEMS"])).await.unwrap();
    assert_eq!(columns[0].name, "ID");
    assert_eq!(columns[2].detail.as_deref(), Some("VARCHAR(100)"));
    let view_columns = client.tree(&at(&["SYSTEM", "TABLES"])).await.unwrap();
    assert!(view_columns.iter().any(|node| node.name == "TABLE_NAME"));
    let sheet = client.describe(&at(&["SHOP", "ITEMS"])).await.unwrap();
    let zone = sheet
        .properties
        .iter()
        .find(|p| p.name == "Distribution zone");
    assert_eq!(zone.unwrap().value, Value::Text("SHOP_ZONE".into()));
    let indexes = sheet.sections.iter().find(|s| s.id == "indexes").unwrap();
    assert_eq!(indexes.rows.len(), 3);
    let ddl = client.ddl(&at(&["SHOP", "ITEMS"])).await.unwrap().sql;
    assert!(
        ddl.starts_with("CREATE TABLE \"SHOP\".\"ITEMS\" ("),
        "{ddl}"
    );
    assert!(
        ddl.contains("PRIMARY KEY USING HASH (\"ID\", \"REGION\")"),
        "{ddl}"
    );
    assert!(
        ddl.contains("COLOCATE BY (\"REGION\") ZONE \"SHOP_ZONE\""),
        "{ddl}"
    );
    assert!(
        ddl.contains("USING SORTED (\"NAME\" DESC, \"PRICE\" ASC)"),
        "{ddl}"
    );
    let view = client.describe(&at(&["SYSTEM", "ZONES"])).await.unwrap();
    assert_eq!(view.kind, "view");
    assert!(client.ddl(&at(&["SYSTEM", "ZONES"])).await.is_err());
}
