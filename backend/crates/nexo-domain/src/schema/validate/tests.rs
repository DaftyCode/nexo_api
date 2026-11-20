use super::*;
use crate::schema::{SchemaOptions, infer};
use serde_json::json;

fn problems(schema: Value, value: Value) -> Vec<String> {
    validate(&schema, &value)
        .problems
        .into_iter()
        .map(|problem| format!("{} {}", problem.path, problem.message))
        .collect()
}

#[test]
fn types_limits_and_fields_are_checked_with_where_they_fail() {
    let schema = json!({
        "type": "object",
        "required": ["id", "name"],
        "properties": {
            "id": {"type": "integer", "minimum": 1},
            "name": {"type": "string", "minLength": 2, "maxLength": 5},
            "email": {"type": "string", "format": "email"},
            "tags": {"type": "array", "items": {"type": "string"}, "maxItems": 2, "uniqueItems": true},
            "price": {"type": "number", "exclusiveMinimum": 0, "multipleOf": 0.01},
            "status": {"enum": ["active", "gone"]},
            "kind": {"const": "user"},
            "note": {"type": ["string", "null"]},
        },
        "additionalProperties": false,
    });
    assert!(
        problems(
            schema.clone(),
            json!({"id": 1, "name": "Ana", "note": null, "price": 1.5})
        )
        .is_empty()
    );
    assert_eq!(
        problems(
            schema,
            json!({
                "id": 1.5, "name": "A", "email": "nope", "tags": ["a", "a", "b"],
                "price": 0, "status": "new", "kind": "admin", "note": 3, "extra": true,
            })
        ),
        [
            "$.id Expected integer, got number",
            "$.name Expected at least 2 characters, got 1",
            "$.email Expected the format email, got \"nope\"",
            "$.tags Expected at most 2 items, got 3",
            "$.tags[1] Expected the items to be unique",
            "$.price Expected a number above 0, got 0",
            "$.status Expected one of [\"active\",\"gone\"], got \"new\"",
            "$.kind Expected \"user\", got \"admin\"",
            "$.note Expected string or null, got number",
            "$.extra This property is not allowed",
        ]
    );
    assert_eq!(
        problems(json!({"required": ["id"]}), json!({"id x": 1})),
        ["$ Missing required property \"id\""]
    );
}

#[test]
fn combinations_references_and_older_drafts_are_read() {
    let schema = json!({
        "$defs": {"item": {"type": "object", "required": ["sku"], "properties": {"sku": {"type": "string"}}}},
        "type": "array",
        "items": {"$ref": "#/$defs/item"},
        "contains": {"required": ["sku"], "properties": {"sku": {"const": "A"}}},
    });
    assert!(problems(schema.clone(), json!([{"sku": "A"}, {"sku": "B"}])).is_empty());
    assert_eq!(
        problems(schema, json!([{"sku": 1}, {}])),
        [
            "$[0].sku Expected string, got number",
            "$[1] Missing required property \"sku\"",
            "$ Expected at least 1 items to match `contains`, got 0",
        ]
    );
    let branches = json!({
        "anyOf": [{"type": "string"}, {"type": "integer"}],
        "oneOf": [{"minimum": 0}, {"maximum": 10}],
        "not": {"const": 5},
    });
    assert!(problems(branches.clone(), json!(20)).is_empty());
    assert_eq!(
        problems(branches, json!(5)),
        [
            "$ Expected the value to match one schema of oneOf, it matches 2",
            "$ Expected the value not to match the schema of not",
        ]
    );
    // Draft 4: exclusive limits as booleans, tuples as a list of items.
    let draft4 = json!({"items": [{"type": "string"}], "additionalItems": false, "maximum": 3, "exclusiveMaximum": true});
    assert_eq!(
        problems(draft4.clone(), json!(["a", 1])),
        ["$[1] No value is allowed here"]
    );
    assert_eq!(
        problems(draft4, json!(3)),
        ["$ Expected a number below 3, got 3"]
    );
    assert_eq!(
        problems(json!({"$ref": "other.json#/a"}), json!(1)),
        ["$ Only references inside the schema are checked: other.json#/a"]
    );
    assert_eq!(
        problems(
            json!({"if": {"type": "string"}, "then": {"minLength": 2}, "else": {"minimum": 1}}),
            json!(0)
        ),
        ["$ Expected at least 1, got 0"]
    );
    // OpenAPI 3.0's nullable, and numbers alike whatever their writing.
    assert!(problems(json!({"type": "string", "nullable": true}), json!(null)).is_empty());
    assert!(problems(json!({"enum": [1, {"a": [2]}]}), json!({"a": [2.0]})).is_empty());
}

#[test]
fn patterns_are_left_to_the_script_and_recursion_is_bounded() {
    let schema =
        json!({"properties": {"code": {"pattern": "^[A-Z]+$"}}, "anyOf": [{"pattern": "x"}, true]});
    let result = validate(&schema, &json!({"code": "ab"}));
    assert!(result.problems.is_empty());
    assert_eq!(
        result.patterns,
        [PatternCheck {
            path: "$.code".into(),
            pattern: "^[A-Z]+$".into(),
            value: "ab".into()
        }]
    );
    let endless = validate(&json!({"$ref": "#"}), &json!(1));
    assert_eq!(
        endless.problems[0].message,
        "The schema refers to itself too deeply"
    );
    let names = validate(
        &json!({"properties": {"a b": {"type": "string"}}}),
        &json!({"a b": 1}),
    );
    assert_eq!(names.problems[0].path, "$[\"a b\"]");
}

#[test]
fn an_inferred_schema_passes_its_samples_and_fails_without_a_required_field() {
    let samples: Vec<Value> = (1..=5)
        .map(|n| {
            let mut user = json!({
                "id": n,
                "email": format!("user{n}@example.com"),
                "created": format!("2026-11-0{n}T10:00:00Z"),
                "ref": "6f1c2b3a-1d2e-4f5a-8b9c-0d1e2f3a4b5c",
                "site": "https://example.com/u",
                "role": if n % 2 == 0 { "admin" } else { "user" },
                "items": [{"sku": format!("A{n}"), "qty": n}],
            });
            if n != 3 {
                user["nickname"] = json!("nick");
            }
            user
        })
        .collect();
    let schema = infer(&samples, SchemaOptions { enums: true });
    assert_eq!(
        schema["$schema"],
        "https://json-schema.org/draft/2020-12/schema"
    );
    assert_eq!(schema["type"], "object");
    let required: Vec<&str> = schema["required"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(Value::as_str)
        .collect();
    assert_eq!(
        required,
        ["id", "email", "created", "ref", "site", "role", "items"]
    );
    let properties = &schema["properties"];
    assert_eq!(properties["email"]["format"], "email");
    assert_eq!(properties["created"]["format"], "date-time");
    assert_eq!(properties["ref"]["format"], "uuid");
    assert_eq!(properties["site"]["format"], "uri");
    assert_eq!(properties["role"]["enum"], json!(["user", "admin"]));
    assert!(
        properties["email"].get("enum").is_none(),
        "values that do not repeat are no enum"
    );
    assert_eq!(
        properties["items"]["items"]["required"],
        json!(["sku", "qty"])
    );
    for sample in &samples {
        assert!(validate(&schema, sample).problems.is_empty(), "{sample}");
    }
    let mut missing = samples[0].clone();
    missing.as_object_mut().unwrap().remove("email");
    assert_eq!(
        problems(schema.clone(), missing),
        ["$ Missing required property \"email\""]
    );
    // Lists and plain values at the top, too.
    let list = infer(&[json!([{"a": 1}]), json!([])], SchemaOptions::default());
    assert_eq!(list["type"], "array");
    assert_eq!(list["items"]["required"], json!(["a"]));
    assert_eq!(
        infer(&[json!("x"), json!(null)], SchemaOptions::default())["type"],
        json!(["string", "null"])
    );
}

#[test]
fn formats_are_read_from_samples_and_checked() {
    use crate::schema::{format_of, matches_format};
    for (text, format) in [
        ("6F1C2B3A-1D2E-4F5A-8B9C-0D1E2F3A4B5C", Some("uuid")),
        ("2026-02-28T23:59:60.123+01:00", Some("date-time")),
        ("2024-02-29", Some("date")),
        ("ana.lopez@mail.example.com", Some("email")),
        ("https://example.com/a?b=1", Some("uri")),
        ("user:7", None),
        ("2023-02-29", None),
        ("2026-11-20T25:00:00Z", None),
        ("2026-11-20T10:00:00", None),
        ("a@b", None),
        ("plain text", None),
    ] {
        assert_eq!(format_of(text), format, "{text}");
    }
    assert!(matches_format("uri", "urn:isbn:0451450523"));
    assert!(!matches_format("uri", "has space:x"));
    assert!(
        matches_format("hostname", "anything"),
        "formats not known are not checked"
    );
}
