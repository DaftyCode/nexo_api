use super::*;
use serde_json::json;
use std::collections::HashSet;

fn column(generator: Value) -> MockColumn {
    serde_json::from_value(json!({"name": "c", "generator": generator})).unwrap()
}
fn one(generator: Value, seed: u64, rows_count: u32) -> Vec<Value> {
    rows(&[column(generator)], seed, 0, rows_count)
        .into_iter()
        .map(|mut row| row.remove(0))
        .collect()
}

#[test]
fn the_same_seed_makes_the_same_rows_whichever_batch_makes_them() {
    let columns = vec![
        column(json!({"kind": "catalog", "catalog": "fullName"})),
        column(json!({"kind": "integer", "min": 1, "max": 1000})),
        column(json!({"kind": "timestamp", "from": "2024-01-01", "to": "2024-12-31"})),
    ];
    let whole = rows(&columns, 7, 0, 100);
    let mut batches = rows(&columns, 7, 0, 40);
    batches.extend(rows(&columns, 7, 40, 60));
    assert_eq!(whole, batches);
    assert_ne!(whole, rows(&columns, 8, 0, 100));
}

#[test]
fn numbers_stay_in_their_range_and_unique_ones_never_repeat() {
    for value in one(json!({"kind": "integer", "min": -5, "max": 5}), 1, 200) {
        assert!((-5..=5).contains(&value.as_i64().unwrap()));
    }
    let mut unique = column(json!({"kind": "integer", "min": 10, "max": 10_009}));
    unique.unique = true;
    let values: HashSet<i64> = rows(&[unique], 3, 0, 10_000)
        .iter()
        .map(|row| row[0].as_i64().unwrap())
        .collect();
    assert_eq!(values.len(), 10_000);
    assert!(values.iter().all(|value| (10..=10_009).contains(value)));
    assert_eq!(
        one(json!({"kind": "sequence", "start": 100, "step": 5}), 1, 3),
        [json!(100), json!(105), json!(110)]
    );
    for value in one(
        json!({"kind": "decimal", "min": 1.5, "max": 2.0, "scale": 2}),
        1,
        100,
    ) {
        let number = value.as_f64().unwrap();
        assert!((1.5..=2.0).contains(&number));
        assert_eq!((number * 100.0).round() / 100.0, number);
    }
}

#[test]
fn texts_follow_their_length_list_pattern_and_catalog() {
    let mut cut = column(json!({"kind": "text", "min": 30, "max": 40}));
    cut.length = Some(10);
    for row in rows(&[cut], 1, 0, 20) {
        assert!(row[0].as_str().unwrap().chars().count() <= 10);
    }
    for value in one(json!({"kind": "pattern", "pattern": "AAA-999-a?"}), 2, 50) {
        let text = value.as_str().unwrap();
        assert_eq!(text.len(), 10);
        assert!(text[..3].chars().all(|c| c.is_ascii_uppercase()));
        assert_eq!(&text[3..4], "-");
        assert!(text[4..7].chars().all(|c| c.is_ascii_digit()));
        assert!(text[8..9].chars().all(|c| c.is_ascii_lowercase()));
    }
    let list = one(json!({"kind": "list", "values": ["red", "green"]}), 2, 30);
    assert!(list.iter().all(|value| value == "red" || value == "green"));
    let mut emails = column(json!({"kind": "catalog", "catalog": "email"}));
    emails.unique = true;
    let made: HashSet<String> = rows(&[emails], 4, 0, 500)
        .iter()
        .map(|row| row[0].as_str().unwrap().to_owned())
        .collect();
    assert_eq!(made.len(), 500);
    assert!(made.iter().all(|email| email.ends_with("@example.com")));
    let mut names = column(json!({"kind": "catalog", "catalog": "city", "language": "es"}));
    names.unique = true;
    names.length = Some(8);
    for row in rows(&[names], 5, 0, 50) {
        assert!(row[0].as_str().unwrap().chars().count() <= 8);
    }
    let phone = one(
        json!({"kind": "catalog", "catalog": "phone", "language": "es"}),
        1,
        1,
    );
    assert!(phone[0].as_str().unwrap().starts_with("+34 6"));
    let uuid = one(json!({"kind": "catalog", "catalog": "uuid"}), 1, 1);
    let uuid = uuid[0].as_str().unwrap();
    assert_eq!(uuid.len(), 36);
    assert_eq!(&uuid[14..15], "4");
    for kind in [
        "firstName",
        "lastName",
        "country",
        "company",
        "street",
        "url",
    ] {
        let value = one(
            json!({"kind": "catalog", "catalog": kind, "language": "es"}),
            1,
            1,
        );
        assert!(!value[0].as_str().unwrap().is_empty(), "{kind}");
    }
}

/// An IBAN is valid when the number made of it, its first four characters at its end and its
/// letters as numbers, gives 1 divided by 97 (ISO 13616).
fn valid_iban(iban: &str) -> bool {
    let moved = format!("{}{}", &iban[4..], &iban[..4]);
    moved
        .chars()
        .map(|c| c.to_digit(36).unwrap())
        .fold(0_u32, |rest, digit| {
            if digit > 9 {
                (rest * 100 + digit) % 97
            } else {
                (rest * 10 + digit) % 97
            }
        })
        == 1
}

#[test]
fn ibans_have_a_valid_check() {
    for (language, country, length) in [("es", "ES", 24), ("en", "DE", 22)] {
        for value in one(
            json!({"kind": "catalog", "catalog": "iban", "language": language}),
            9,
            50,
        ) {
            let iban = value.as_str().unwrap();
            assert!(iban.starts_with(country) && iban.len() == length, "{iban}");
            assert!(valid_iban(iban), "{iban}");
        }
    }
}

#[test]
fn dates_booleans_json_binary_keys_and_nulls() {
    for value in one(
        json!({"kind": "date", "from": "2024-02-27", "to": "2024-03-01"}),
        1,
        50,
    ) {
        assert!(
            ["2024-02-27", "2024-02-28", "2024-02-29", "2024-03-01"]
                .contains(&value.as_str().unwrap())
        );
    }
    assert_eq!(
        catalogs::date(catalogs::days("1970-01-01").unwrap()),
        "1970-01-01"
    );
    assert_eq!(
        catalogs::date(catalogs::days("2000-12-31").unwrap()),
        "2000-12-31"
    );
    let stamp = one(
        json!({"kind": "timestamp", "from": "2024-01-01", "to": "2024-01-01"}),
        1,
        1,
    );
    assert!(stamp[0].as_str().unwrap().starts_with("2024-01-01 "));
    let truths = one(json!({"kind": "boolean", "ratio": 0.0}), 1, 20);
    assert!(truths.iter().all(|value| value == false));
    let json = one(
        json!({"kind": "json", "template": "{\"n\": {{row}}, \"id\": \"{{uuid}}\", \"w\": \"{{word}}\", \"i\": {{int}}, \"who\": \"{{firstName}} {{email}}\"}"}),
        1,
        2,
    );
    let parsed: Value = serde_json::from_str(json[1].as_str().unwrap()).unwrap();
    assert_eq!(parsed["n"], 2);
    let binary = one(json!({"kind": "binary", "size": 4}), 1, 1);
    assert_eq!(binary[0]["$t"], "binary");
    assert_eq!(binary[0]["v"].as_str().unwrap().len(), 8);
    assert_eq!(text::base64(b"Man"), "TWFu");
    assert_eq!(text::base64(b"Ma"), "TWE=");
    let keys = one(json!({"kind": "foreign", "values": [1, 2, 3]}), 1, 30);
    assert!(
        keys.iter()
            .all(|key| [1, 2, 3].contains(&key.as_i64().unwrap()))
    );
    assert_eq!(
        one(json!({"kind": "foreign", "values": []}), 1, 1),
        [Value::Null]
    );
    let mut nulls = column(json!({"kind": "integer", "min": 1, "max": 9}));
    nulls.nulls = 1.0;
    assert!(rows(&[nulls], 1, 0, 10).iter().all(|row| row[0].is_null()));
}

#[test]
fn generators_are_checked_before_anything_is_made() {
    assert!(validate(&[]).is_err());
    for (generator, why) in [
        (
            json!({"kind": "integer", "min": 2, "max": 1}),
            "smallest number",
        ),
        (
            json!({"kind": "decimal", "min": 0, "max": 1, "scale": 20}),
            "12 decimals",
        ),
        (
            json!({"kind": "text", "min": 0, "max": 20_000}),
            "10,000 at most",
        ),
        (json!({"kind": "list", "values": []}), "1 to 10,000"),
        (json!({"kind": "pattern", "pattern": ""}), "1 to 1,000"),
        (
            json!({"kind": "date", "from": "2024-13-01", "to": "2024-01-01"}),
            "YYYY-MM-DD",
        ),
        (
            json!({"kind": "date", "from": "2024-02-01", "to": "2024-01-01"}),
            "after the last",
        ),
        (json!({"kind": "boolean", "ratio": 2}), "share of true"),
        (json!({"kind": "binary", "size": 2_000_000}), "1 MB"),
    ] {
        let error = validate(&[column(generator)]).unwrap_err().to_string();
        assert!(error.contains(why), "{error}");
    }
    let mut nulls = column(json!({"kind": "boolean", "ratio": 0.5}));
    nulls.nulls = 1.5;
    assert!(validate(&[nulls]).is_err());
    assert!(validate(&[column(json!({"kind": "sequence", "start": 1, "step": 1}))]).is_ok());
    assert!(
        serde_json::from_value::<MockColumn>(json!({"name": "c", "generator": {"kind": "magic"}}))
            .is_err()
    );
}
