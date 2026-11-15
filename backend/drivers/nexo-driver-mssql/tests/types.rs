//! Every type of the fixture's `every_type` table comes back with its exact value and the
//! name SQL Server gives its type.
mod common;

use common::{driver, params, run};
use nexo_driver_sdk::{Value, ValueKind, limits};
use std::collections::HashMap;

fn typed(kind: ValueKind, text: &str) -> Value {
    Value::typed(kind, text)
}

#[tokio::test]
async fn every_type_keeps_its_value() {
    let connect = fixture!(params("types"));
    let client = driver();
    client.connect(&connect).await.unwrap();
    let result = run(&client, "types", "SELECT * FROM dbo.every_type ORDER BY id")
        .await
        .unwrap();
    let row: HashMap<&str, &Value> = result
        .columns
        .iter()
        .map(|column| column.name.as_str())
        .zip(&result.rows[0])
        .collect();
    let kind: HashMap<&str, (&str, ValueKind)> = result
        .columns
        .iter()
        .map(|column| {
            (
                column.name.as_str(),
                (column.type_name.as_str(), column.kind),
            )
        })
        .collect();
    use ValueKind::*;
    for (column, expected) in [
        ("a_bigint", Value::Integer(i64::MAX)),
        (
            "a_decimal",
            typed(Decimal, "1234567890123456789012345678.0123456789"),
        ),
        ("a_money", typed(Decimal, "922337203685.4775")),
        ("a_bit", Value::Bool(true)),
        ("a_datetime", typed(Timestamp, "2026-11-13T10:20:30.123")),
        (
            "a_datetime2",
            typed(Timestamp, "2026-11-13T10:20:30.1234567"),
        ),
        (
            "a_datetimeoffset",
            typed(Timestamptz, "2026-11-13T10:20:30.1234567+02:00"),
        ),
        ("a_time", typed(Time, "10:20:30.1234567")),
        ("a_date", typed(Date, "2026-11-13")),
        (
            "a_uuid",
            typed(Uuid, "6f9619ff-8b86-d011-b42d-00c04fc964ff"),
        ),
        ("a_varbinary", Value::bytes(&[0x00, 0xff, 0x10])),
        ("a_xml", typed(Xml, "<a><b>1</b></a>")),
        ("a_text", Value::Text("x".repeat(10))),
        ("a_float", Value::Float(1.5)),
        ("a_real", Value::Float(2.5)),
        ("a_tinyint", Value::Integer(255)),
    ] {
        assert_eq!(row[column], &expected, "{column}");
    }
    for (column, name) in [
        ("a_bigint", "bigint"),
        ("a_tinyint", "tinyint"),
        ("a_real", "real"),
        ("a_float", "float"),
        ("a_money", "money"),
        ("a_datetime", "datetime"),
        ("a_datetime2", "datetime2"),
        ("a_uuid", "uniqueidentifier"),
        ("a_text", "nvarchar"),
    ] {
        assert_eq!(kind[column].0, name, "{column}");
    }
    // rowversion, hierarchyid and geography arrive as their bytes.
    for column in ["a_rowversion", "a_hierarchy", "a_geography"] {
        assert!(
            matches!(row[column], Value::Typed { kind: Binary, .. }),
            "{column}: {:?}",
            row[column]
        );
        assert_eq!(kind[column].1, Binary, "{column}");
    }

    // Nulls of every kind, and a value bigger than the limit of one, cut and told so.
    let nulls = run(
        &client,
        "types",
        "SELECT CAST(NULL AS bigint), CAST(NULL AS datetime2), CAST(NULL AS uniqueidentifier), \
         CAST(NULL AS money), CAST(NULL AS xml), CAST(NULL AS varbinary(4)), CAST(NULL AS bit)",
    )
    .await
    .unwrap();
    assert!(
        nulls.rows[0].iter().all(|value| *value == Value::Null),
        "{:?}",
        nulls.rows
    );
    assert_eq!(nulls.columns[0].type_name, "bigint");
    let big = run(
        &client,
        "types",
        "SELECT REPLICATE(CAST(N'x' AS nvarchar(max)), 2000000)",
    )
    .await
    .unwrap();
    match &big.rows[0][0] {
        Value::Typed {
            kind: Text,
            text,
            full_size,
        } => {
            assert_eq!(text.len(), limits::VALUE_BYTES);
            assert_eq!(*full_size, Some(2_000_000));
        }
        other => panic!("{other:?}"),
    }
}
