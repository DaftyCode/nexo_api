//! Comparing two versions of a definition.
use super::super::*;
use super::*;

#[test]
fn the_diff_finds_every_change_and_marks_the_breaking_ones() {
    let diff = compare(&json!({"base": VALID, "source": CHANGED})).unwrap();
    assert_eq!(diff["breaking"], 8);
    assert_eq!(
        diff["removed"],
        json!([{"method": "delete", "path": "/orders/{orderId}",
                "pointer": "/paths/~1orders~1{orderId}/delete", "line": 60}])
    );
    assert_eq!(diff["added"][0]["method"], "put");
    assert_eq!(diff["added"][0]["path"], "/orders/{id}");
    assert_eq!(
        changes_of(&diff, "get", "/orders"),
        vec![
            change("schema-type", &["query status", "string", "integer"], true),
            change("parameter-added-required", &["query", "customer"], true),
            change("enum-removed", &["response 200[].status", "closed"], true),
            change("property-added", &["response 200[].total"], false),
        ]
    );
    assert_eq!(
        changes_of(&diff, "post", "/orders"),
        vec![
            change(
                "enum-removed",
                &["body application/json.status", "closed"],
                true
            ),
            change(
                "property-added-required",
                &["body application/json.total"],
                true
            ),
            change("enum-removed", &["response 201.status", "closed"], true),
            change("property-added", &["response 201.total"], false),
        ]
    );
    // The path variable was renamed: the same endpoint, matched by position.
    assert_eq!(
        changes_of(&diff, "get", "/orders/{id}"),
        vec![
            change("enum-removed", &["response 200.status", "closed"], true),
            change("property-added", &["response 200.total"], false),
            change("response-removed", &["404"], false),
        ]
    );
    let first = &diff["changed"][0]["changes"][0];
    assert_eq!(first["side"], "source");
    assert_eq!(first["line"], 15);
    // Nothing changed between a definition and itself.
    assert_eq!(
        compare(&json!({"base": VALID, "source": VALID})).unwrap(),
        json!({"breaking": 0, "added": [], "removed": [], "changed": []})
    );
}

#[test]
fn the_diff_table_of_breaking_changes() {
    // Each case: a change to one operation, and whether it breaks clients.
    let base = "openapi: 3.0.0\ninfo: {title: A, version: '1'}\npaths:\n  /a:\n    post:\n      parameters:\n        - {name: q, in: query, schema: {type: string}}\n      requestBody:\n        content:\n          application/json:\n            schema:\n              type: object\n              required: [name]\n              properties:\n                name: {type: string}\n                tags: {type: array, items: {type: string, enum: [a, b]}}\n      responses:\n        '200':\n          description: ok\n          content:\n            application/json:\n              schema:\n                type: object\n                properties:\n                  id: {type: integer}\n        '400': {description: bad}\n";
    for (from, to, rule, breaking) in [
        (
            "{name: q, in: query, schema: {type: string}}",
            "{name: q, in: query, required: true, schema: {type: string}}",
            "parameter-required",
            true,
        ),
        (
            "        - {name: q, in: query, schema: {type: string}}\n",
            "        - {name: q, in: query, schema: {type: string}}\n        - {name: x, in: header, schema: {type: string}}\n",
            "parameter-added",
            false,
        ),
        (
            "parameters:\n        - {name: q, in: query, schema: {type: string}}\n",
            "parameters: []\n",
            "parameter-removed",
            false,
        ),
        ("enum: [a, b]", "enum: [a]", "enum-removed", true),
        ("enum: [a, b]", "enum: [a, b, c]", "", false),
        (
            "                  id: {type: integer}\n",
            "",
            "property-removed",
            true,
        ),
        (
            "                name: {type: string}\n",
            "",
            "property-removed",
            false,
        ),
        (
            "        '200':\n          description: ok",
            "        '201':\n          description: ok",
            "response-removed",
            true,
        ),
        (
            "        '400': {description: bad}\n",
            "",
            "response-removed",
            false,
        ),
        (
            "required: [name]",
            "required: [name, tags]",
            "property-required",
            true,
        ),
        (
            "application/json:\n            schema:\n              type: object",
            "text/plain:\n            schema:\n              type: object",
            "body-media-removed",
            true,
        ),
        (
            "      requestBody:\n",
            "      requestBody:\n        required: true\n",
            "body-required",
            true,
        ),
    ] {
        assert_eq!(base.matches(from).count(), 1, "{from}");
        let changed = base.replace(from, to);
        let diff = compare(&json!({"base": base, "source": changed})).unwrap();
        let found = changes_of(&diff, "post", "/a");
        if rule.is_empty() {
            assert!(found.is_empty(), "{to}: {found:?}");
            continue;
        }
        assert!(
            found.iter().any(|(r, _, b)| r == rule && *b == breaking),
            "{rule}: {found:?}"
        );
    }
    // A body added that clients must send breaks them; an optional one does not.
    let without = base.replace(
        "      requestBody:\n        content:\n          application/json:\n            schema:\n              type: object\n              required: [name]\n              properties:\n                name: {type: string}\n                tags: {type: array, items: {type: string, enum: [a, b]}}\n",
        "",
    );
    let added = compare(&json!({"base": without, "source": base})).unwrap();
    assert_eq!(
        changes_of(&added, "post", "/a"),
        vec![change("body-added", &[], false)]
    );
    let removed = compare(&json!({"base": base, "source": without})).unwrap();
    assert_eq!(
        changes_of(&removed, "post", "/a"),
        vec![change("body-removed", &[], false)]
    );
    assert!(
        compare(&json!({"base": "[unclosed", "source": base}))
            .unwrap_err()
            .to_string()
            .contains("earlier")
    );
}

#[test]
fn swagger_2_definitions_are_compared_too() {
    let changed = SWAGGER
        .replace(
            "          type: string\n      security",
            "          type: integer\n      security",
        )
        .replace(
            "      name:\n        type: string\n",
            "      name:\n        type: integer\n",
        );
    let diff = compare(&json!({"base": SWAGGER, "source": changed})).unwrap();
    assert_eq!(
        changes_of(&diff, "get", "/pets/{petId}"),
        vec![
            change("schema-type", &["path petId", "string", "integer"], true),
            change(
                "schema-type",
                &["response 200.name", "string", "integer"],
                true
            ),
        ]
    );
    assert_eq!(
        changes_of(&diff, "post", "/pets"),
        vec![change(
            "schema-type",
            &["body body.name", "string", "integer"],
            true
        )]
    );
}
