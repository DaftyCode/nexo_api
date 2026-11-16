//! Each type of MySQL and MariaDB comes back exact: integers at their limits (unsigned ones
//! past what JSON holds as text), decimals, bits, dates (also MySQL's zero ones), times past a
//! day, JSON, enumerations, sets, binaries and geometries, from both protocols.
mod common;

use common::{driver, mariadb, params, run};
use nexo_driver_sdk::{Value, ValueKind, statements::ExecuteParams};

fn typed(kind: ValueKind, text: &str) -> Value {
    Value::typed(kind, text)
}

#[tokio::test]
async fn every_type_comes_back_exact() {
    for (connect, mysql) in [(params("types"), true), (mariadb("types"), false)] {
        let connect = fixture!(connect);
        let client = driver();
        client.connect(&connect).await.unwrap();
        let result = run(&client, "types", "SELECT * FROM every_type ORDER BY id")
            .await
            .unwrap();
        let named = |name: &str| {
            let at = result.columns.iter().position(|c| c.name == name).unwrap();
            (result.columns[at].clone(), result.rows[0][at].clone())
        };
        assert_eq!(named("tiny").1, Value::Integer(-128));
        assert_eq!(named("big").1, Value::Integer(i64::MIN));
        let (column, value) = named("unsigned_big");
        assert_eq!(column.type_name, "bigint unsigned");
        assert_eq!(value, typed(ValueKind::Decimal, "18446744073709551615"));
        assert_eq!(
            named("money").1,
            typed(ValueKind::Decimal, "12345678901234567890.123456789")
        );
        assert_eq!(named("real_value").1, Value::Float(1.5));
        assert_eq!(named("flag").1, Value::Bool(true));
        assert_eq!(named("bits").1, Value::Integer(257));
        assert_eq!(named("day").1, typed(ValueKind::Date, "2026-11-16"));
        assert_eq!(
            named("moment").1,
            typed(ValueKind::Timestamp, "2026-11-16T10:20:30.123456")
        );
        assert_eq!(named("clock").1, typed(ValueKind::Time, "800:00:00.500000"));
        assert_eq!(named("year_value").1, Value::Integer(2026));
        assert_eq!(named("word").1, Value::Text("año".into()));
        assert_eq!(named("status").1, Value::Text("b".into()));
        assert_eq!(named("tags").1, Value::Text("x,y".into()));
        assert_eq!(named("raw").1, Value::bytes(&[0, 255]));
        let (column, doc) = named("doc");
        // MariaDB's JSON is text with a check.
        if mysql {
            assert_eq!(column.kind, ValueKind::Json);
            assert_eq!(doc, typed(ValueKind::Json, r#"{"a": [1, 2]}"#));
        } else {
            assert_eq!(doc, Value::Text(r#"{"a": [1, 2]}"#.into()));
        }
        let (column, place) = named("place");
        assert_eq!(column.kind, ValueKind::Spatial);
        assert!(
            matches!(
                place,
                Value::Typed {
                    kind: ValueKind::Spatial,
                    ..
                }
            ),
            "{place:?}"
        );
        assert!(
            result.rows[1][1..]
                .iter()
                .all(|value| *value == Value::Null)
        );
        // The key comes with its column, and where it comes from.
        let id = &result.columns[0];
        assert!(id.key, "{id:?}");
        assert_eq!(id.origin.as_ref().unwrap().table, "every_type");
        // Zero dates.
        let zero = run(&client, "types", "SELECT day, moment FROM zero_dates")
            .await
            .unwrap();
        assert_eq!(
            zero.rows[0],
            [
                typed(ValueKind::Date, "0000-00-00"),
                typed(ValueKind::Timestamp, "0000-00-00T00:00:00")
            ]
        );
        // The same values with a parameter bound: the binary protocol.
        let bound = client
            .execute(&ExecuteParams {
                connection: "types".into(),
                statement: "bound".into(),
                sql: "SELECT unsigned_big, clock, moment, flag FROM every_type WHERE id = ?".into(),
                params: vec![Value::Integer(1)],
                page_rows: None,
                max_rows: None,
            })
            .await
            .unwrap();
        assert_eq!(
            bound.rows[0],
            [
                typed(ValueKind::Decimal, "18446744073709551615"),
                typed(ValueKind::Time, "800:00:00.500000"),
                typed(ValueKind::Timestamp, "2026-11-16T10:20:30.123456"),
                Value::Bool(true),
            ]
        );
    }
}
