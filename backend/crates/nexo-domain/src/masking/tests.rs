use super::*;
use serde_json::json;

/// A stand-in for the engine's keyed hash: FNV-1a spread over 32 bytes, keyed by `key`.
fn keyed(key: u8) -> impl Fn(&[u8]) -> [u8; 32] {
    move |input: &[u8]| {
        let mut out = [0u8; 32];
        let mut hash: u64 = 0xcbf2_9ce4_8422_2325 ^ u64::from(key);
        for (at, slot) in out.iter_mut().enumerate() {
            for byte in input.iter().chain(&[at as u8]) {
                hash ^= u64::from(*byte);
                hash = hash.wrapping_mul(0x0100_0000_01b3);
            }
            *slot = (hash >> 24) as u8;
        }
        out
    }
}

fn masked(rules: Value, mut document: Value) -> Value {
    let rules = Rules::read(&json!({ "rules": rules })).unwrap();
    let digest = keyed(1);
    Masker::new(&rules, &digest).document(&mut document);
    document
}

#[test]
fn reads_rules_and_refuses_what_is_wrong() {
    let read = |rules: Value| Rules::read(&json!({ "rules": rules }));
    assert!(
        read(json!([{"path": " ", "method": "hide"}]))
            .unwrap()
            .is_empty()
    );
    assert!(
        !read(json!([{"path": "email", "method": "hash"}]))
            .unwrap()
            .is_empty()
    );
    assert!(read(json!([{"path": "email", "method": "shred"}])).is_err());
    assert!(read(json!([{"path": "a..b", "method": "hide"}])).is_err());
    assert!(read(json!([{"path": "a", "method": "truncate", "keep": 13}])).is_err());
    assert!(read(json!([{"path": "a", "method": "truncate", "keep": -1}])).is_err());
    assert!(read(json!([{"path": "a".repeat(301), "method": "hide"}])).is_err());
    let many: Vec<Value> = (0..=MAX_RULES)
        .map(|_| json!({"path": "a", "method": "hide"}))
        .collect();
    assert!(read(json!(many)).is_err());
    assert!(Rules::read(&json!({})).is_err());
    assert!(validate(&json!({"rules": []})).is_ok());
    assert!(for_agents(&json!({"rules": [], "agents": true})));
    assert!(!for_agents(&json!({"rules": []})));
}

#[test]
fn hides_truncates_and_removes_fields_by_name_at_any_depth() {
    let document = masked(
        json!([
            {"path": "password", "method": "remove"},
            {"path": "card.number", "method": "truncate"},
            {"path": "pin", "method": "hide"},
            {"path": "phone", "method": "truncate", "keep": 0},
        ]),
        json!({
            "user": {"Password": "s3cret", "pin": 1234, "phone": "600 000 000", "note": null},
            "card": [{"number": "4111 1111 1111 1234"}, {"number": "12"}],
            "pin": null,
            "kept": "as it was",
        }),
    );
    assert_eq!(
        document,
        json!({
            "user": {"pin": "****", "phone": "****", "note": null},
            "card": [{"number": "**** 1234"}, {"number": "****"}],
            "pin": null,
            "kept": "as it was",
        })
    );
}

#[test]
fn anchored_paths_and_items_name_only_what_they_say() {
    let document = masked(
        json!([
            {"path": "$.meta.id", "method": "hide"},
            {"path": "tags[*]", "method": "remove"},
            {"path": "$.list[1]", "method": "hide"},
        ]),
        json!({"meta": {"id": 1}, "other": {"meta": {"id": 2}}, "tags": ["a", "b"], "list": [1, 2, 3]}),
    );
    assert_eq!(
        document,
        json!({"meta": {"id": "****"}, "other": {"meta": {"id": 2}}, "tags": [], "list": [1, "****", 3]})
    );
}

#[test]
fn hashes_are_tokens_of_the_value_and_the_key() {
    let document = masked(
        json!([{"path": "email", "method": "hash"}]),
        json!([{"email": "ana@corp.com"}, {"email": "ana@corp.com"}, {"email": "luis@corp.com"}, {"email": 7}, {"email": "7"}]),
    );
    let tokens: Vec<&str> = (0..5)
        .map(|at| document[at]["email"].as_str().unwrap())
        .collect();
    assert_eq!(tokens[0].len(), 16);
    assert!(tokens[0].chars().all(|c| c.is_ascii_hexdigit()));
    assert_eq!(tokens[0], tokens[1]);
    assert_ne!(tokens[0], tokens[2]);
    assert_ne!(tokens[3], tokens[4]);
    let rules = Rules::read(&json!({"rules": [{"path": "email", "method": "hash"}]})).unwrap();
    let mut other = json!({"email": "ana@corp.com"});
    let digest = keyed(2);
    Masker::new(&rules, &digest).document(&mut other);
    assert_ne!(other["email"], tokens[0]);
}

#[test]
fn synthetic_values_keep_their_form_and_follow_the_value() {
    let original = json!({
        "email": "ana.real@corp.com",
        "fullName": "Ana Maria Real",
        "lastName": "Real",
        "fileName": "report.pdf",
        "born": "1984-05-17T10:20:30.5Z",
        "id": "65a1f00dcafe0123456789ab",
        "phone": "+34 600-12-34",
        "age": 42,
        "price": -17.25,
        "active": true,
        "count": {"$t": "integer", "v": "123"},
        "nothing": null,
    });
    let rules: Vec<Value> = original
        .as_object()
        .unwrap()
        .keys()
        .map(|key| json!({"path": key, "method": "synthetic"}))
        .collect();
    let made = masked(json!(rules), original.clone());
    let text = |key: &str| made[key].as_str().unwrap().to_string();
    assert!(text("email").ends_with("@example.com"));
    let names: Vec<String> = text("fullName").split(' ').map(String::from).collect();
    assert_eq!(names.len(), 3);
    assert!(FIRST_NAMES.contains(&names[0].as_str()));
    assert!(LAST_NAMES.contains(&names[2].as_str()));
    assert!(LAST_NAMES.contains(&text("lastName").as_str()));
    let file = text("fileName");
    assert_eq!(file.len(), "report.pdf".len());
    assert_eq!(&file[6..7], ".");
    let born = text("born");
    let year: u32 = born[0..4].parse().unwrap();
    let month: u32 = born[5..7].parse().unwrap();
    let hour: u32 = born[11..13].parse().unwrap();
    assert!((1950..2010).contains(&year) && (1..=12).contains(&month) && hour < 24);
    assert!(born.ends_with(".5Z"));
    let id = text("id");
    assert_eq!(id.len(), 24);
    assert!(
        id.chars()
            .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase())
    );
    let phone = text("phone");
    assert_eq!(phone.len(), "+34 600-12-34".len());
    assert_eq!((&phone[0..1], &phone[3..4], &phone[7..8]), ("+", " ", "-"));
    let age = made["age"].as_i64().unwrap();
    assert!((10..100).contains(&age));
    assert!(made["price"].as_f64().unwrap() < 0.0);
    assert!(made["active"].is_boolean());
    assert_eq!(made["count"]["$t"], "integer");
    assert_eq!(made["count"]["v"].as_str().unwrap().len(), 3);
    assert!(made["nothing"].is_null());
    // The same value always becomes the same made-up one.
    assert_eq!(masked(json!(rules), original.clone()), made);
    // None of the original values is left.
    for (key, value) in original.as_object().unwrap() {
        if !value.is_null() && key != "active" {
            assert_ne!(&made[key], value, "{key}");
        }
    }
}

#[test]
fn long_texts_draw_as_many_bytes_as_they_need() {
    let long = "x".repeat(200);
    let made = masked(
        json!([{"path": "notes", "method": "synthetic"}]),
        json!({"notes": long}),
    );
    let made = made["notes"].as_str().unwrap();
    assert_eq!(made.len(), 200);
    assert!(made.chars().all(|c| c.is_ascii_lowercase()));
    assert_ne!(made, long);
}

#[test]
fn rows_mask_their_columns_and_drop_the_removed_ones() {
    let rules = Rules::read(&json!({"rules": [
        {"path": "SECRET", "method": "remove"},
        {"path": "email", "method": "hide"},
        {"path": "name", "method": "synthetic"},
    ]}))
    .unwrap();
    let digest = keyed(1);
    let columns = ["id", "Email", "secret", "name"].map(String::from);
    let mut rows = vec![
        vec![json!(1), json!("a@b.c"), json!("x"), json!("Ana Real")],
        vec![json!(2), Value::Null, json!("y"), json!("Luis")],
    ];
    let kept = Masker::new(&rules, &digest).rows(&columns, &mut rows);
    assert_eq!(kept, vec![0, 1, 3]);
    assert_eq!(rows[0][..2], [json!(1), json!("****")]);
    assert_eq!(rows[1][1], Value::Null);
    assert_eq!(rows[0].len(), 3);
    let name = rows[0][2].as_str().unwrap();
    assert!(FIRST_NAMES.contains(&name.split(' ').next().unwrap()));
}

#[test]
fn methods_read_and_write_their_names() {
    for method in Method::ALL {
        assert_eq!(Method::parse(method.as_str()).unwrap(), method);
    }
}

#[test]
fn typed_values_are_truncated_by_what_they_hold() {
    let document = masked(
        json!([{"path": "account", "method": "truncate", "keep": 2}, {"path": "doc", "method": "truncate", "keep": 3}]),
        json!({"account": {"$numberLong": "123456"}, "doc": {"a": 1}}),
    );
    assert_eq!(document["account"], "**** 56");
    assert_eq!(document["doc"], "**** :1}");
}

#[test]
fn sets_join_and_say_which_paths_they_name() {
    let mut rules = Rules::read(&json!({"rules": [{"path": "card", "method": "hide"}]})).unwrap();
    assert!(rules.names(&["Card", "number"]));
    assert!(!rules.names(&["email"]));
    rules.extend(Rules::read(&json!({"rules": [{"path": "email", "method": "hash"}]})).unwrap());
    assert!(rules.names(&["user", "email"]));
    assert!(!rules.names(&[]));
}
