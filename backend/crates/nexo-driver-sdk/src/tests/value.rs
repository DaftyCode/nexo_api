use crate::value::{Column, Origin, SAFE_INTEGER, Value, ValueKind};
use serde_json::{Value as Json, json};

/// Each value with the JSON it travels as.
fn cases() -> Vec<(Value, Json)> {
    vec![
        (Value::Null, json!(null)),
        (Value::Bool(true), json!(true)),
        (Value::Integer(42), json!(42)),
        (Value::Integer(-SAFE_INTEGER), json!(-SAFE_INTEGER)),
        (
            Value::Integer(SAFE_INTEGER + 1),
            json!({"$t": "integer", "v": "9007199254740992"}),
        ),
        (
            Value::Integer(i64::MIN),
            json!({"$t": "integer", "v": "-9223372036854775808"}),
        ),
        (Value::Float(1.5), json!(1.5)),
        (Value::Float(2.0), json!(2.0)),
        (
            Value::Float(f64::INFINITY),
            json!({"$t": "float", "v": "inf"}),
        ),
        (Value::Text("año".into()), json!("año")),
        (Value::Text(String::new()), json!("")),
        (
            Value::typed(ValueKind::Decimal, "12345678901234567890.123456789"),
            json!({"$t": "decimal", "v": "12345678901234567890.123456789"}),
        ),
        (
            Value::typed(ValueKind::Timestamptz, "2026-11-13T10:00:00+01:00"),
            json!({"$t": "timestamptz", "v": "2026-11-13T10:00:00+01:00"}),
        ),
        (
            Value::typed(ValueKind::Json, r#"{"$t": "text", "v": 1}"#),
            json!({"$t": "json", "v": "{\"$t\": \"text\", \"v\": 1}"}),
        ),
        (
            Value::bytes(&[0, 255, 16]),
            json!({"$t": "binary", "v": "AP8Q"}),
        ),
        (
            Value::Array(vec![
                Value::Integer(1),
                Value::Null,
                Value::Text("a".into()),
            ]),
            json!({"$t": "array", "v": [1, null, "a"]}),
        ),
        (
            Value::Array(vec![Value::Array(vec![Value::typed(ValueKind::Uuid, "u")])]),
            json!({"$t": "array", "v": [{"$t": "array", "v": [{"$t": "uuid", "v": "u"}]}]}),
        ),
    ]
}

#[test]
fn values_travel_without_losing_their_type() {
    for (value, json) in cases() {
        assert_eq!(serde_json::to_value(&value).unwrap(), json, "{value:?}");
        let back: Value = serde_json::from_value(json).unwrap();
        assert_eq!(back, value);
    }
}

#[test]
fn not_a_number_travels_as_text() {
    let json = serde_json::to_value(Value::Float(f64::NAN)).unwrap();
    assert_eq!(json, json!({"$t": "float", "v": "NaN"}));
    let back: Value = serde_json::from_value(json).unwrap();
    assert!(matches!(back, Value::Float(value) if value.is_nan()));
}

#[test]
fn what_is_not_a_value_is_refused() {
    for json in [
        json!([1, 2]),
        json!({"v": "x"}),
        json!({"$t": "decimal"}),
        json!({"$t": "nonsense", "v": "x"}),
        json!({"$t": "decimal", "v": 12}),
        json!({"$t": "integer", "v": "twelve"}),
        json!({"$t": "array", "v": "x"}),
    ] {
        assert!(
            serde_json::from_value::<Value>(json.clone()).is_err(),
            "{json}"
        );
    }
}

#[test]
fn bytes_come_back() {
    assert_eq!(
        Value::bytes(b"\x00nexo\xff").as_bytes().unwrap(),
        b"\x00nexo\xff"
    );
    assert_eq!(Value::Text("AP8Q".into()).as_bytes(), None);
}

#[test]
fn long_text_is_cut_at_a_character_and_says_its_size() {
    let cut = Value::Text("añoñ".into()).truncated(2);
    assert_eq!(
        serde_json::to_value(&cut).unwrap(),
        json!({"$t": "text", "v": "a", "truncated": true, "size": 6})
    );
    let back: Value = serde_json::from_value(serde_json::to_value(&cut).unwrap()).unwrap();
    assert_eq!(back, cut);
    // What fits, and what is not text, stays as it was.
    assert_eq!(
        Value::Text("año".into()).truncated(4),
        Value::Text("año".into())
    );
    assert_eq!(Value::Integer(123456).truncated(2), Value::Integer(123456));
    let decimal = Value::typed(ValueKind::Decimal, "123456");
    assert_eq!(decimal.clone().truncated(2), decimal);
    let json = Value::typed(ValueKind::Json, "[1,2,3]").truncated(3);
    assert!(matches!(
        json,
        Value::Typed {
            full_size: Some(7),
            ..
        }
    ));
}

#[test]
fn a_column_says_where_it_comes_from() {
    let mut column = Column::new("total", "numeric(10,2)", ValueKind::Decimal);
    assert_eq!(
        serde_json::to_value(&column).unwrap(),
        json!({"name": "total", "typeName": "numeric(10,2)", "kind": "decimal"})
    );
    column.nullable = Some(false);
    column.key = true;
    column.origin = Some(Origin {
        schema: Some("public".into()),
        table: "orders".into(),
        column: "total".into(),
    });
    let json = serde_json::to_value(&column).unwrap();
    assert_eq!(
        json["origin"],
        json!({"schema": "public", "table": "orders", "column": "total"})
    );
    assert_eq!(json["key"], json!(true));
    assert_eq!(serde_json::from_value::<Column>(json).unwrap(), column);
}
