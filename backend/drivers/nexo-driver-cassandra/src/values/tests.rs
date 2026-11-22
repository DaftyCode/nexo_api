use super::numbers::{
    bigint_bytes, bigint_text, civil, date_text, decimal_text, duration_text, time_text,
};
use super::*;
use crate::values::bind::parse_timestamp;
use nexo_driver_sdk::ValueKind;
use scylla::value::{CqlDate, CqlDecimal, CqlDuration, CqlTimeuuid, CqlVarint};
use serde_json::json;

#[test]
fn integers_of_any_size_go_to_text_and_back() {
    for text in [
        "0",
        "1",
        "-1",
        "127",
        "128",
        "-128",
        "-129",
        "255",
        "256",
        "9007199254740993",
        "-170141183460469231731687303715884105728",
    ] {
        let bytes = bigint_bytes(text).unwrap();
        assert_eq!(bigint_text(&bytes), text, "{text}");
    }
    assert_eq!(bigint_bytes("128").unwrap(), [0, 128]);
    assert_eq!(bigint_bytes("-128").unwrap(), [128]);
    assert_eq!(bigint_bytes("+7").unwrap(), [7]);
    assert_eq!(bigint_text(&[]), "0");
    assert!(bigint_bytes("1.5").is_none());
    assert!(bigint_bytes("").is_none());
    let decimal = |bytes: &str, scale| {
        decimal_text(&CqlDecimal::from_signed_be_bytes_and_exponent(
            bigint_bytes(bytes).unwrap(),
            scale,
        ))
    };
    assert_eq!(decimal("150", 2), "1.50");
    assert_eq!(decimal("-5", 3), "-0.005");
    assert_eq!(decimal("12", -2), "1200");
}

#[test]
fn dates_times_and_durations_are_written_as_cql_writes_them() {
    assert_eq!(civil(0), (1970, 1, 1));
    assert_eq!(date_text(CqlDate((1 << 31) + 19_723)), "2024-01-01");
    assert_eq!(date_text(CqlDate((1 << 31) - 1)), "1969-12-31");
    assert_eq!(time_text(3_723_000_000_123), "01:02:03.000000123");
    assert_eq!(time_text(0), "00:00:00");
    assert_eq!(
        timestamp_text(1_704_164_645_006),
        "2024-01-02T03:04:05.006Z"
    );
    assert_eq!(timestamp_text(-1000), "1969-12-31T23:59:59Z");
    let duration = |months, days, nanoseconds| {
        duration_text(&CqlDuration {
            months,
            days,
            nanoseconds,
        })
    };
    assert_eq!(duration(14, 3, 3_723_004_005_006), "1y2mo3d1h2m3s4ms5us6ns");
    assert_eq!(duration(0, 0, 0), "0s");
    assert_eq!(duration(0, -1, 0), "-1d");
    assert_eq!(
        parse_timestamp("2024-01-02T03:04:05.006Z"),
        Some(1_704_164_645_006)
    );
    assert_eq!(
        parse_timestamp("2024-01-02 04:04:05+01:00"),
        Some(1_704_164_645_000)
    );
    assert_eq!(parse_timestamp("2024-01-02"), Some(1_704_153_600_000));
    assert_eq!(parse_timestamp("nope"), None);
}

#[test]
fn values_keep_their_kind() {
    let uuid: uuid::Uuid = "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11".parse().unwrap();
    assert_eq!(from_cql(None), Value::Null);
    assert_eq!(
        from_cql(Some(&CqlValue::BigInt(1 << 60))),
        Value::Integer(1 << 60)
    );
    assert_eq!(
        from_cql(Some(&CqlValue::Varint(CqlVarint::from_signed_bytes_be(
            bigint_bytes("9007199254740993").unwrap()
        )))),
        Value::typed(ValueKind::Integer, "9007199254740993")
    );
    assert_eq!(
        from_cql(Some(&CqlValue::Timeuuid(CqlTimeuuid::from(uuid)))),
        Value::typed(ValueKind::Uuid, uuid.to_string())
    );
    assert_eq!(
        from_cql(Some(&CqlValue::Blob(vec![1, 2]))),
        Value::bytes(&[1, 2])
    );
    assert_eq!(
        from_cql(Some(&CqlValue::Inet("10.0.0.1".parse().unwrap()))),
        Value::Text("10.0.0.1".into())
    );
    assert_eq!(
        from_cql(Some(&CqlValue::List(vec![
            CqlValue::Int(1),
            CqlValue::Text("a".into())
        ]))),
        Value::Array(vec![Value::Integer(1), Value::Text("a".into())])
    );
    let map = from_cql(Some(&CqlValue::Map(vec![(
        CqlValue::Text("k".into()),
        CqlValue::Int(1),
    )])));
    assert_eq!(
        map,
        Value::typed(ValueKind::Json, json!({"k": 1}).to_string())
    );
    let pairs = from_cql(Some(&CqlValue::Map(vec![(
        CqlValue::Int(1),
        CqlValue::Text("a".into()),
    )])));
    assert_eq!(
        pairs,
        Value::typed(ValueKind::Json, json!([[1, "a"]]).to_string())
    );
    let udt = from_cql(Some(&CqlValue::UserDefinedType {
        keyspace: "shop".into(),
        name: "address".into(),
        fields: vec![
            ("city".into(), Some(CqlValue::Text("Lima".into()))),
            ("zip".into(), None),
        ],
    }));
    assert_eq!(
        udt,
        Value::typed(
            ValueKind::Json,
            json!({"city": "Lima", "zip": null}).to_string()
        )
    );
    assert_eq!(
        from_cql(Some(&CqlValue::Tuple(vec![
            Some(CqlValue::Boolean(true)),
            None
        ]))),
        Value::Array(vec![Value::Bool(true), Value::Null])
    );
}

#[test]
fn bound_values_are_written_as_the_statement_expects() {
    let native = |native| ColumnType::Native(native);
    let bind = |value: Value, native| to_cql(&value, &ColumnType::Native(native)).unwrap();
    assert_eq!(
        bind(Value::Text("42".into()), NativeType::Int),
        Some(CqlValue::Int(42))
    );
    assert_eq!(
        bind(Value::Integer(7), NativeType::BigInt),
        Some(CqlValue::BigInt(7))
    );
    assert_eq!(
        bind(Value::Text("true".into()), NativeType::Boolean),
        Some(CqlValue::Boolean(true))
    );
    assert_eq!(bind(Value::Null, NativeType::Text), None);
    assert_eq!(
        bind(
            Value::typed(ValueKind::Decimal, "1.50"),
            NativeType::Decimal
        ),
        Some(CqlValue::Decimal(
            CqlDecimal::from_signed_be_bytes_and_exponent(vec![0, 150], 2)
        ))
    );
    assert_eq!(
        bind(Value::Text("2024-01-01".into()), NativeType::Date),
        Some(CqlValue::Date(CqlDate((1 << 31) + 19_723)))
    );
    assert_eq!(
        bind(
            Value::Text("2024-01-02T03:04:05.006Z".into()),
            NativeType::Timestamp
        ),
        Some(CqlValue::Timestamp(scylla::value::CqlTimestamp(
            1_704_164_645_006
        )))
    );
    assert_eq!(
        bind(Value::Text("01:02:03.5".into()), NativeType::Time),
        Some(CqlValue::Time(scylla::value::CqlTime(3_723_500_000_000)))
    );
    assert_eq!(
        bind(Value::bytes(&[9]), NativeType::Blob),
        Some(CqlValue::Blob(vec![9]))
    );
    assert!(to_cql(&Value::Text("x".into()), &native(NativeType::Int)).is_err());
    assert!(to_cql(&Value::Integer(1 << 40), &native(NativeType::Int)).is_err());
    assert_eq!(
        column_type(&native(NativeType::Uuid)),
        ("uuid".into(), ValueKind::Uuid)
    );
}
