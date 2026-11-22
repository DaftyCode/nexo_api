//! Values compared, written as literals for each engine, and definitions without noise.
use super::super::*;
use serde_json::json;

#[test]
fn values_compare_by_what_they_are_and_between_engines_with_the_declared_normalization() {
    let same = |a: Value, b: Value, between: bool| canonical(&a, between) == canonical(&b, between);
    // The JSON of an engine without that type is text: between engines it is read as JSON.
    let document = json!({"$t": "json", "v": "{\"a\": 1, \"b\": [2]}"});
    assert!(same(document.clone(), json!(" {\"b\":[2],\"a\":1}"), true));
    assert!(!same(document, json!("{\"b\":[2],\"a\":1}"), false));
    assert!(!same(json!("{not json"), json!("{not json "), false));
    assert!(same(json!("{not json"), json!("{not json "), true));
    assert!(same(
        json!({"$t": "decimal", "v": "5.50"}),
        json!(5.5),
        false
    ));
    assert!(same(
        json!({"$t": "decimal", "v": "-0.000"}),
        json!(0),
        false
    ));
    assert!(same(
        json!({"$t": "integer", "v": "9007199254740993"}),
        json!({"$t": "decimal", "v": "9007199254740993.0"}),
        false
    ));
    assert!(!same(json!("5"), json!(5), false));
    assert!(same(json!(true), json!(1), true));
    assert!(!same(json!(true), json!(1), false));
    assert!(same(json!("ab  "), json!("ab"), true));
    assert!(!same(json!("ab  "), json!("ab"), false));
    assert!(same(
        json!({"$t": "timestamptz", "v": "2026-01-01 01:30:00+02:00"}),
        json!({"$t": "timestamp", "v": "2025-12-31T23:30:00.000000"}),
        true
    ));
    assert!(same(
        json!({"$t": "uuid", "v": "6F1C2B3A-1D2E-4F5A-8B9C-0D1E2F3A4B5C"}),
        json!("6f1c2b3a-1d2e-4f5a-8b9c-0d1e2f3a4b5c"),
        true
    ));
    assert!(same(
        json!({"$t": "json", "v": "{\"b\":1,\"a\":[2]}"}),
        json!({"$t": "json", "v": "{\"a\": [2], \"b\": 1}"}),
        false
    ));
    assert_eq!(timestamp("2024-02-29 23:00:00-02"), "2024-03-01 01:00:00");
    assert_eq!(
        timestamp("2026-11-21 10:00:00.120Z"),
        "2026-11-21 10:00:00.12"
    );
    assert_eq!(timestamp("not a time"), "not a time");
}

#[test]
fn literals_are_written_for_each_engine_and_definitions_compare_without_noise() {
    assert_eq!(
        literal(&json!("O'Neil \\ x"), Dialect::MySql),
        "'O''Neil \\\\ x'"
    );
    assert_eq!(literal(&json!("O'Neil"), Dialect::PostgreSql), "'O''Neil'");
    assert_eq!(literal(&json!("é"), Dialect::TSql), "N'é'");
    // CQL writes blobs in hexadecimal and UUIDs bare.
    assert_eq!(
        literal(&json!({"$t": "binary", "v": "AQL/"}), Dialect::Cql),
        "0x0102ff"
    );
    assert_eq!(
        literal(
            &json!({"$t": "uuid", "v": "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11"}),
            Dialect::Cql
        ),
        "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11"
    );
    assert_eq!(literal(&json!(null), Dialect::Ansi), "NULL");
    assert_eq!(literal(&json!(true), Dialect::TSql), "1");
    assert_eq!(literal(&json!(false), Dialect::PostgreSql), "FALSE");
    assert_eq!(
        literal(&json!({"$t": "decimal", "v": "12.50"}), Dialect::MySql),
        "12.50"
    );
    assert_eq!(
        literal(&json!({"$t": "decimal", "v": "1; DROP"}), Dialect::MySql),
        "'1; DROP'"
    );
    assert_eq!(
        literal(&json!({"$t": "binary", "v": "AQL/"}), Dialect::PostgreSql),
        "'\\x0102ff'::bytea"
    );
    assert_eq!(
        literal(&json!({"$t": "binary", "v": "AQL/"}), Dialect::TSql),
        "0x0102ff"
    );
    assert_eq!(
        literal(&json!({"$t": "date", "v": "2026-11-21"}), Dialect::Sqlite),
        "'2026-11-21'"
    );
    assert_eq!(
        definition(
            "CREATE VIEW \"shop\".\"v\" AS\n  SELECT a -- the key\n FROM shop.t WHERE b = 'X  Y';",
            Some("shop")
        ),
        definition("create view v as select A from t where B = 'X  Y'", None)
    );
    assert_ne!(
        definition("select 'a'", None),
        definition("select 'A'", None)
    );
}
