//! Every type of the fixture's `every_type` table comes back with its exact value, on the
//! current server and on the oldest supported one.
mod common;

use common::{driver, params, run};
use nexo_driver_sdk::{
    Value, ValueKind,
    protocol::ConnectParams,
    statements::{ExecuteParams, TransactionAction, TransactionParams},
};

fn typed(kind: ValueKind, text: &str) -> Value {
    Value::typed(kind, text)
}

async fn every_type(connect: ConnectParams) {
    let name = connect.connection.clone();
    let client = driver();
    client.connect(&connect).await.unwrap();
    let result = run(&client, &name, "SELECT * FROM every_type ORDER BY id")
        .await
        .unwrap();
    let row: std::collections::HashMap<&str, &Value> = result
        .columns
        .iter()
        .map(|column| column.name.as_str())
        .zip(&result.rows[0])
        .collect();
    use ValueKind::*;
    let text = |text: &str| Value::Text(text.into());
    for (column, expected) in [
        ("small", Value::Integer(-32768)),
        ("big", Value::Integer(i64::MAX)),
        ("exact", typed(Decimal, "12345678901234567890.123456789")),
        ("money_value", typed(Decimal, "123.45")),
        ("real_value", Value::Float(1.5)),
        ("double_value", Value::Float(std::f64::consts::PI)),
        ("flag", Value::Bool(true)),
        ("label", text("año")),
        ("letter", text("ab ")),
        ("body", text("line\nnext")),
        ("raw", Value::bytes(&[0x00, 0xff, 0x10])),
        ("day", typed(Date, "2026-11-13")),
        ("moment", typed(Time, "24:00:00")),
        ("moment_tz", typed(Time, "12:30:00+01:00")),
        ("stamp", typed(Timestamp, "2026-11-13T10:00:00.500")),
        ("stamp_tz", typed(Timestamptz, "2026-11-13T10:00:00Z")),
        ("span", typed(Interval, "1 year 2 mons 3 days 04:05:06.5")),
        (
            "id_value",
            typed(Uuid, "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11"),
        ),
        ("doc", typed(Json, "{\"b\": 1, \"a\": [true, null]}")),
        ("docb", typed(Json, "{\"a\": 2, \"b\": 1}")),
        ("markup", typed(Xml, "<a>1</a>")),
        ("address", typed(Other, "192.168.1.5")),
        ("network", typed(Other, "10.0.0.0/8")),
        ("mac", typed(Other, "08:00:2b:01:02:03")),
        ("bits", typed(Other, "1010")),
        (
            "tags",
            Value::Array(vec![text("x"), Value::Null, text("y,z")]),
        ),
        (
            "grid",
            Value::Array(vec![
                Value::Array(vec![Value::Integer(1), Value::Integer(2)]),
                Value::Array(vec![Value::Integer(3), Value::Integer(4)]),
            ]),
        ),
        ("during", typed(Other, "[1,10)")),
        ("state", text("paid")),
        ("place", typed(Other, "(Main St,Madrid)")),
        ("attributes", typed(Other, "\"k\"=>\"v\", \"n\"=>NULL")),
        ("far", typed(Date, "infinity")),
        ("point_value", typed(Other, "(1.5,-2)")),
    ] {
        assert_eq!(row[column], &expected, "{column}");
    }
    // The second row has only nulls besides its id.
    assert!(
        result.rows[1][1..]
            .iter()
            .all(|value| *value == Value::Null)
    );
    let kinds: Vec<ValueKind> = result
        .columns
        .iter()
        .take(4)
        .map(|column| column.kind)
        .collect();
    assert_eq!(kinds, [Integer, Integer, Integer, Decimal]);
}

#[tokio::test]
async fn every_type_comes_back_exact() {
    every_type(fixture!(params("types", None))).await;
}

#[tokio::test]
async fn the_oldest_supported_server_reads_the_same() {
    every_type(fixture!(params("types-old", Some("NEXO_SQL_PG_OLD_PORT")))).await;
}

#[tokio::test]
async fn bound_values_are_read_as_their_columns_types() {
    let connect = fixture!(params("bound", None));
    let client = driver();
    client.connect(&connect).await.unwrap();
    let statement = |sql: &str, params: Vec<Value>| ExecuteParams {
        connection: "bound".into(),
        statement: "bound".into(),
        sql: sql.into(),
        params,
        page_rows: None,
        max_rows: None,
    };
    let found = client
        .execute(&statement(
            "SELECT id FROM every_type WHERE big = $1 AND raw = $2 AND day = $3 AND label = $4",
            vec![
                Value::Integer(i64::MAX),
                Value::bytes(&[0x00, 0xff, 0x10]),
                typed(ValueKind::Date, "2026-11-13"),
                Value::Text("año".into()),
            ],
        ))
        .await
        .unwrap();
    assert_eq!(found.rows, [[Value::Integer(1)]]);
    // A value with quotes is a value, never part of the statement.
    let quoted = client
        .execute(&statement(
            "SELECT count(*) FROM shop.customers WHERE email = $1",
            vec![Value::Text("x' OR '1'='1".into())],
        ))
        .await
        .unwrap();
    assert_eq!(quoted.rows, [[Value::Integer(0)]]);

    // In manual mode a write waits for the commit, and a rollback undoes it.
    let manual = TransactionParams {
        connection: "bound".into(),
        action: TransactionAction::Manual,
        isolation: None,
    };
    client.transaction(&manual).await.unwrap();
    let written = client
        .execute(&statement(
            "INSERT INTO shop.customers (email) VALUES ($1)",
            vec![Value::Text("manual@example.com".into())],
        ))
        .await
        .unwrap();
    assert_eq!(written.affected, Some(1));
    let state = client
        .transaction(&TransactionParams {
            action: TransactionAction::Status,
            ..manual.clone()
        })
        .await
        .unwrap();
    assert!(state.open && !state.auto_commit);
    client
        .transaction(&TransactionParams {
            action: TransactionAction::Rollback,
            ..manual.clone()
        })
        .await
        .unwrap();
    let count = client
        .execute(&statement(
            "SELECT count(*) FROM shop.customers WHERE email = 'manual@example.com'",
            Vec::new(),
        ))
        .await
        .unwrap();
    assert_eq!(count.rows, [[Value::Integer(0)]]);
    // Notices of the server come with the statement that raised them.
    let noticed = client
        .execute(&statement(
            "DO $$ BEGIN RAISE NOTICE 'hello from the server'; END $$",
            Vec::new(),
        ))
        .await
        .unwrap();
    assert_eq!(noticed.notices[0].message, "hello from the server");
}
