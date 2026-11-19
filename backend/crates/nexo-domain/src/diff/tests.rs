use super::*;
use serde_json::json;

fn patterns(texts: &[&str]) -> Vec<Pattern> {
    texts
        .iter()
        .map(|text| Pattern::parse(text).unwrap())
        .collect()
}

fn paths(found: &[FieldDifference]) -> Vec<&str> {
    found.iter().map(|d| d.path.as_str()).collect()
}

#[test]
fn finds_the_fields_that_differ_and_leaves_out_the_ignored_ones() {
    let source = json!({
        "_id": 1, "name": "Ana", "at": {"$date": {"$numberLong": "1"}},
        "address": {"city": "Lugo", "zip": "27001"}, "tags": ["a", "b"],
        "updatedAt": {"$date": {"$numberLong": "5"}}, "only": true,
    });
    let target = json!({
        "_id": 1, "name": "Ana", "at": {"$date": {"$numberLong": "2"}},
        "address": {"city": "Vigo", "zip": "27001"}, "tags": ["a"],
        "updatedAt": {"$date": {"$numberLong": "9"}}, "extra": 3,
    });
    let found = differences(&source, &target, &["updatedAt".into()]);
    assert_eq!(
        paths(&found),
        ["at", "address.city", "tags", "only", "extra"]
    );
    assert_eq!(
        found[3],
        FieldDifference {
            path: "only".into(),
            source: Some(json!(true)),
            target: None
        }
    );
    assert_eq!(found[4].source, None);
    assert!(differences(&source, &source, &[]).is_empty());
    // A whole embedded document ignored, and a field that only looks like it.
    let ignore = ["address".to_string()];
    assert!(
        !differences(
            &json!({"address": 1, "addressee": 1}),
            &json!({"address": 2, "addressee": 1}),
            &ignore
        )
        .iter()
        .any(|d| d.path.starts_with("address"))
    );
    assert_eq!(
        differences(&json!({"addressee": 1}), &json!({"addressee": 2}), &ignore)[0].path,
        "addressee"
    );
}

#[test]
fn reads_values_at_dotted_paths() {
    let document = json!({"customer": {"address": {"city": "Lugo"}}, "n": 1});
    assert_eq!(
        value_at(&document, "customer.address.city"),
        Some(&json!("Lugo"))
    );
    assert_eq!(value_at(&document, "n"), Some(&json!(1)));
    assert_eq!(value_at(&document, "customer.zip"), None);
    assert_eq!(value_at(&document, "n.x"), None);
}

#[test]
fn compares_bodies_item_by_item_whatever_the_order_of_their_fields() {
    let source = json!({
        "id": 7, "name": "Ana", "updatedAt": "2026-11-18",
        "items": [{"sku": "a", "qty": 1}, {"sku": "b", "qty": 2}],
        "meta": {"page": 1, "next": null}, "gone": "x",
    });
    let target = json!({
        "meta": {"next": null, "page": 2}, "name": "Ana", "updatedAt": "2026-11-19",
        "items": [{"qty": 1, "sku": "a"}, {"sku": "b", "qty": 3}, {"sku": "c", "qty": 1}],
        "id": 7, "added": true,
    });
    let (found, complete) = body_differences(&source, &target, &[]);
    assert!(complete);
    assert_eq!(
        paths(&found),
        [
            "$.updatedAt",
            "$.items[1].qty",
            "$.items[2]",
            "$.meta.page",
            "$.gone",
            "$.added"
        ]
    );
    assert_eq!(found[2].source, None);
    assert_eq!(found[2].target, Some(json!({"sku": "c", "qty": 1})));
    assert_eq!(found[4].target, None);
    // Leaving out `updatedAt` leaves out exactly that difference.
    let (found, _) = body_differences(&source, &target, &patterns(&["updatedAt"]));
    assert_eq!(
        paths(&found),
        [
            "$.items[1].qty",
            "$.items[2]",
            "$.meta.page",
            "$.gone",
            "$.added"
        ]
    );
    assert!(body_differences(&source, &source, &[]).0.is_empty());
}

#[test]
fn tells_nulls_missing_fields_and_other_types_apart() {
    let (found, _) = body_differences(
        &json!({"a": null, "b": 1, "c": "1", "d": [1], "e": {}, "f": 0, "g": false}),
        &json!({"b": null, "c": 1, "d": {"0": 1}, "e": [], "f": 0.0, "g": 0}),
        &[],
    );
    assert_eq!(
        found,
        [
            FieldDifference {
                path: "$.a".into(),
                source: Some(json!(null)),
                target: None
            },
            FieldDifference {
                path: "$.b".into(),
                source: Some(json!(1)),
                target: Some(json!(null))
            },
            FieldDifference {
                path: "$.c".into(),
                source: Some(json!("1")),
                target: Some(json!(1))
            },
            FieldDifference {
                path: "$.d".into(),
                source: Some(json!([1])),
                target: Some(json!({"0": 1}))
            },
            FieldDifference {
                path: "$.e".into(),
                source: Some(json!({})),
                target: Some(json!([]))
            },
            FieldDifference {
                path: "$.f".into(),
                source: Some(json!(0)),
                target: Some(json!(0.0))
            },
            FieldDifference {
                path: "$.g".into(),
                source: Some(json!(false)),
                target: Some(json!(0))
            },
        ]
    );
    // Whole documents of different types, and arrays at the top.
    let (found, _) = body_differences(&json!([1, 2]), &json!("text"), &[]);
    assert_eq!(paths(&found), ["$"]);
    let (found, _) = body_differences(&json!([1, 2, 3]), &json!([1, 5]), &[]);
    assert_eq!(paths(&found), ["$[1]", "$[2]"]);
    assert_eq!(found[1].target, None);
}

#[test]
fn writes_paths_as_jsonpath() {
    let path = [
        Segment::Key("data".into()),
        Segment::Index(0),
        Segment::Key("content-type".into()),
        Segment::Key("$oid".into()),
        Segment::Key("2nd".into()),
        Segment::Key("say \"hi\"".into()),
    ];
    assert_eq!(
        json_path(&path),
        r#"$.data[0]["content-type"].$oid["2nd"]["say \"hi\""]"#
    );
    assert_eq!(json_path(&[]), "$");
}

#[test]
fn patterns_name_fields_at_any_depth_or_from_the_document() {
    let path = |text: &[Segment]| text.to_vec();
    let key = |key: &str| Segment::Key(key.into());
    let at = [key("data"), Segment::Index(3), key("updatedAt")];
    let covers = |pattern: &str, path: &[Segment]| Pattern::parse(pattern).unwrap().covers(path);
    assert!(covers("updatedAt", &at));
    assert!(covers("  updatedAt ", &at));
    assert!(covers("$.data[3].updatedAt", &at));
    assert!(covers("$.data[*].updatedAt", &at));
    assert!(covers("$.data.*.updatedAt", &at));
    assert!(
        covers("data[*]", &at),
        "what is under a named path is left out"
    );
    assert!(covers("$.data", &at));
    assert!(covers("$.**.updatedAt", &at));
    assert!(covers("$", &at));
    assert!(covers("[3]", &at));
    assert!(covers("$['data'][3][\"updatedAt\"]", &at));
    assert!(!covers("$.updatedAt", &at), "anchored at the document");
    assert!(!covers("$.data[2].updatedAt", &at));
    assert!(!covers("$.data.updatedAt", &at));
    assert!(!covers("updated", &at));
    assert!(
        !covers("$.*", &path(&[])),
        "the document itself is never a field"
    );
    assert!(covers("$oid", &[key("_id"), key("$oid")]));
    assert!(covers(r#"["content-type"]"#, &[key("content-type")]));
    assert!(covers(r#"$["a.b"]"#, &[key("a.b")]));
    assert!(covers(r#"$["say \"hi\""]"#, &[key("say \"hi\"")]));
    assert!(covers("**.**.id", &[key("id")]));
    assert!(!covers("[*]", &[key("id")]), "[*] is an item, not a field");
    for invalid in [
        "", "  ", "a..b", "a.", "$.", "a[", "a[x]", "a[1", "$x.[", "a]", "['a",
    ] {
        assert!(Pattern::parse(invalid).is_err(), "{invalid:?} is refused");
    }
}

#[test]
fn shows_bodies_in_alphabetical_order_without_what_is_ignored() {
    let body = json!({
        "z": 1, "a": {"y": [{"k": 1, "b": 2}], "updatedAt": "x"}, "updatedAt": "y", "list": [1, 2, 3]
    });
    let shown = canonical(&body, &patterns(&["updatedAt", "$.list[1]"]));
    assert_eq!(
        serde_json::to_string(&shown).unwrap(),
        r#"{"a":{"y":[{"b":2,"k":1}]},"list":[1,3],"z":1}"#
    );
    assert_eq!(canonical(&json!("text"), &[]), json!("text"));
}

#[test]
fn stops_at_the_most_differences_it_reports() {
    let many: Vec<u64> = (0..2000).collect();
    let (found, complete) = body_differences(&json!(many), &json!([]), &[]);
    assert_eq!(found.len(), MAX_BODY_DIFFERENCES);
    assert!(!complete);
    let documents: Map<String, Value> = (0..200).map(|n| (format!("f{n}"), json!(n))).collect();
    assert_eq!(
        differences(&Value::Object(documents), &json!({}), &[]).len(),
        MAX_FIELD_DIFFERENCES
    );
}
