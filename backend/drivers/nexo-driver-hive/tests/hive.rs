//! The Hive module against the fixture's HiveServer2 in HTTP mode (`tools/nosql-fixture.sh`):
//! the conformance checks, the tree down to a table's columns, Hive's types kept, a sheet and
//! a DDL, and an address the egress policy refuses.
mod common;

use common::{Host, driver, driver_with, params};
use nexo_driver_hive::HiveDriver;
use nexo_driver_sdk::{
    Value, ValueKind,
    conformance::{Suite, check},
    protocol::ObjectParams,
    statements::ExecuteParams,
};

/// 1,201 rows without a table: one per position of a string of 1,200 spaces.
const PAGED: &str =
    "SELECT pos FROM (SELECT posexplode(split(space(1200), ' ')) AS (pos, val)) t ORDER BY pos";

#[tokio::test]
async fn hive_passes_the_conformance_checks() {
    let connect = fixture!(params("conformance"));
    let suite = Suite {
        connect,
        // HiveServer2 without authentication takes any password.
        wrong_password: None,
        paged_sql: PAGED.into(),
        paged_rows: 1201,
        slow_sql: Some("SELECT reflect('java.lang.Thread', 'sleep', 60000L)".into()),
        invalid_sql: "SELECT FROM".into(),
        values: vec![
            (
                "SELECT 'O\\'Brien' AS t".into(),
                Value::Text("O'Brien".into()),
            ),
            ("SELECT CAST(NULL AS STRING) AS t".into(), Value::Null),
            ("SELECT CAST(7 AS BIGINT) AS t".into(), Value::Integer(7)),
        ],
        rollback: None,
    };
    let failures = check(HiveDriver::default(), suite).await;
    assert!(failures.is_empty(), "{failures:#?}");
}

#[tokio::test]
async fn hive_types_are_kept_and_the_tree_reaches_the_columns() {
    let connect = fixture!(params("types"));
    let client = driver();
    client.connect(&connect).await.unwrap();
    let run = |sql: &str| ExecuteParams {
        connection: "types".into(),
        statement: "s".into(),
        sql: sql.into(),
        params: Vec::new(),
        page_rows: None,
        max_rows: None,
    };
    let typed = client
        .execute(&run(
            "SELECT CAST(1 AS TINYINT) AS t, CAST(1.50 AS DECIMAL(5,2)) AS d, \
             DATE '2024-01-02' AS day, TIMESTAMP '2024-01-02 03:04:05' AS at, \
             array(1, 2) AS a, map('k', 1) AS m, true AS b, CAST('AB' AS BINARY) AS bin",
        ))
        .await
        .unwrap();
    let kinds: Vec<_> = typed.columns.iter().map(|column| column.kind).collect();
    assert_eq!(
        kinds,
        [
            ValueKind::Integer,
            ValueKind::Decimal,
            ValueKind::Date,
            ValueKind::Timestamp,
            ValueKind::Json,
            ValueKind::Json,
            ValueKind::Boolean,
            ValueKind::Binary,
        ]
    );
    assert_eq!(typed.columns[1].type_name, "decimal(5,2)");
    let row = &typed.rows[0];
    assert_eq!(row[0], Value::Integer(1));
    assert_eq!(row[1], Value::typed(ValueKind::Decimal, "1.50"));
    assert_eq!(row[2], Value::typed(ValueKind::Date, "2024-01-02"));
    assert_eq!(row[4], Value::typed(ValueKind::Json, "[1,2]"));
    assert_eq!(row[6], Value::Bool(true));
    assert_eq!(row[7], Value::bytes(b"AB"));

    for sql in [
        "CREATE DATABASE IF NOT EXISTS nexo_tree",
        "DROP TABLE IF EXISTS nexo_tree.people",
        "CREATE TABLE nexo_tree.people (id INT, name STRING, tags ARRAY<STRING>) PARTITIONED BY (country STRING)",
        "CREATE VIEW IF NOT EXISTS nexo_tree.names AS SELECT name FROM nexo_tree.people",
    ] {
        client.execute(&run(sql)).await.unwrap();
    }
    let tree = |path: &[&str]| {
        let client = client.clone();
        let path = path.iter().map(|part| (*part).to_owned()).collect();
        async move {
            client
                .tree(&ObjectParams {
                    connection: "types".into(),
                    path,
                })
                .await
                .unwrap()
        }
    };
    assert!(tree(&[]).await.iter().any(|node| node.name == "nexo_tree"));
    let tables = tree(&["nexo_tree"]).await;
    let kinds: Vec<_> = tables
        .iter()
        .map(|node| (node.name.as_str(), node.kind.as_str()))
        .collect();
    assert!(kinds.contains(&("people", "table")), "{kinds:?}");
    assert!(kinds.contains(&("names", "view")), "{kinds:?}");
    let columns = tree(&["nexo_tree", "people"]).await;
    let names: Vec<_> = columns.iter().map(|node| node.name.as_str()).collect();
    assert_eq!(names, ["id", "name", "tags", "country"]);
    let object = ObjectParams {
        connection: "types".into(),
        path: vec!["nexo_tree".into(), "people".into()],
    };
    let sheet = client.describe(&object).await.unwrap();
    assert!(
        sheet.sections[0]
            .rows
            .iter()
            .any(|row| row[0] == Value::Text("name".into()))
    );
    let ddl = client.ddl(&object).await.unwrap();
    // Hive 4 makes tables external by default.
    assert!(
        ddl.sql
            .starts_with("CREATE EXTERNAL TABLE `nexo_tree`.`people`"),
        "{}",
        ddl.sql
    );
    assert!(ddl.sql.contains("PARTITIONED BY"), "{}", ddl.sql);
    client
        .execute(&run("DROP DATABASE nexo_tree CASCADE"))
        .await
        .unwrap();
}

#[tokio::test]
async fn an_address_the_policy_refuses_is_never_connected() {
    let connect = fixture!(params("refused"));
    let host = Host::default();
    host.refused
        .lock()
        .unwrap()
        .push(connect.host.clone().unwrap());
    let error = driver_with(host).connect(&connect).await.unwrap_err();
    assert!(error.message.contains("egress policy"), "{error}");
}
