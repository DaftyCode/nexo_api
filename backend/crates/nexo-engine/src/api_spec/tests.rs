//! Table tests over the definitions in `fixtures/`: a valid one, one with known problems, a
//! Swagger 2.0 one and a second version of the valid one with known changes.
use super::*;

const VALID: &str = include_str!("fixtures/valid.yaml");
const CHANGED: &str = include_str!("fixtures/changed.yaml");
const ERRORS: &str = include_str!("fixtures/errors.yaml");
const SWAGGER: &str = include_str!("fixtures/swagger.yaml");

fn inspect_source(source: &str) -> Value {
    inspect(&json!({"source": source})).unwrap()
}
/// The findings as `(severity, rule, params, line)`.
fn findings(source: &str) -> Vec<(String, String, Vec<String>, u64)> {
    inspect_source(source)["findings"]
        .as_array()
        .unwrap()
        .iter()
        .map(|finding| {
            (
                finding["severity"].as_str().unwrap().to_string(),
                finding["rule"].as_str().unwrap().to_string(),
                finding["params"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|p| p.as_str().unwrap().to_string())
                    .collect(),
                finding["line"].as_u64().unwrap_or(0),
            )
        })
        .collect()
}
fn row(
    severity: &str,
    rule: &str,
    params: &[&str],
    line: u64,
) -> (String, String, Vec<String>, u64) {
    (
        severity.into(),
        rule.into(),
        params.iter().map(|p| p.to_string()).collect(),
        line,
    )
}

#[test]
fn a_valid_definition_has_no_findings() {
    let result = inspect_source(VALID);
    assert_eq!(result["version"], "3.1");
    assert_eq!(result["findings"], json!([]));
}

#[test]
fn known_problems_are_found_exactly_with_their_lines() {
    assert_eq!(
        findings(ERRORS),
        vec![
            row("error", "info-version", &[], 2),
            row("error", "path-slash", &["orders"], 37),
            row(
                "error",
                "ref-unresolved",
                &["#/components/schemas/Missing"],
                20
            ),
            row(
                "error",
                "operation-id-duplicate",
                &["getUser", "GET /users/{userId}"],
                23
            ),
            row("error", "path-parameter-required", &["id"], 10),
            row(
                "error",
                "path-parameter-missing",
                &["userId", "GET /users/{userId}"],
                6
            ),
            row(
                "error",
                "path-parameter-unused",
                &["id", "/users/{userId}"],
                10
            ),
            row("error", "operation-responses", &["GET /users"], 22),
            row("error", "parameter-location", &["trace", "body2"], 30),
            row("error", "security-undefined", &["oauth"], 28),
            row(
                "warning",
                "response-example",
                &["200", "application/json"],
                18
            ),
            row("warning", "operation-summary", &["GET /users"], 22),
            row(
                "warning",
                "response-schema",
                &["201", "application/json"],
                36
            ),
            row("warning", "operation-summary", &["POST /users"], 25),
            row(
                "warning",
                "response-example",
                &["200", "application/json"],
                45
            ),
            row(
                "warning",
                "operation-id-style",
                &["create_user", "camelCase"],
                26
            ),
        ]
    );
}

#[test]
fn swagger_2_is_linted_with_the_same_rules() {
    assert_eq!(inspect_source(SWAGGER)["version"], "2.0");
    assert_eq!(
        findings(SWAGGER),
        vec![
            row("error", "security-undefined", &["basicAuth"], 16),
            row("warning", "response-example", &["200", ""], 18),
            row("warning", "response-schema", &["200", ""], 35),
        ]
    );
    let outline = &inspect_source(SWAGGER)["outline"];
    let add = &outline["paths"][1]["operations"][0];
    assert_eq!(add["operationId"], "addPet");
    assert_eq!(
        add["requestBody"],
        json!({"required": true, "media": ["application/json"], "schema": "Pet",
               "pointer": "/paths/~1pets/post/parameters/0", "line": 29})
    );
    assert_eq!(add["parameters"], json!([]));
    assert_eq!(outline["schemas"][0]["name"], "Pet");
    assert_eq!(outline["schemas"][0]["pointer"], "/definitions/Pet");
}

#[test]
fn documents_that_are_not_definitions_are_explained() {
    for (source, expected) in [
        ("[1, 2]", row("error", "structure-root", &[], 1)),
        (
            "openapi: 4.0.0\ninfo: {}",
            row("error", "version", &["4.0.0"], 1),
        ),
        ("title: nothing", row("error", "version", &[""], 1)),
        (
            "openapi: 3.0.0\ninfo:\n  title: A\n  version: '1'\n",
            row("error", "paths-missing", &[], 1),
        ),
        (
            "openapi: 3.0.0\ninfo:\n  title: A\n  version: '1'\npaths: []\n",
            row("error", "paths-invalid", &[], 5),
        ),
        (
            "swagger: '2.0'\ninfo: 1\npaths: {}",
            row("error", "info-missing", &[], 1),
        ),
        (
            "openapi: 3.0.0\ninfo:\n  version: 1\npaths: {}",
            row("error", "info-title", &[], 2),
        ),
    ] {
        let found = findings(source);
        assert!(found.contains(&expected), "{source}: {found:?}");
    }
    // OpenAPI 3.1 may have only components.
    assert_eq!(
        findings("openapi: 3.1.0\ninfo:\n  title: A\n  version: '1'\ncomponents: {}"),
        vec![]
    );
    let broken = findings("openapi: 3.0.0\ninfo:\n  title: [unclosed\n");
    assert_eq!(broken.len(), 1);
    assert_eq!(broken[0].1, "parse");
    assert!(broken[0].3 >= 3, "{broken:?}");
    let external = findings(
        "openapi: 3.1.0\ninfo:\n  title: A\n  version: '1'\ncomponents:\n  schemas:\n    A:\n      $ref: 'other.yaml#/A'\n",
    );
    assert_eq!(
        external,
        vec![row("info", "ref-external", &["other.yaml#/A"], 8)]
    );
    let invalid = findings(
        "openapi: 3.0.0\ninfo:\n  title: A\n  version: '1'\npaths:\n  /a:\n    get:\n      summary: A\n      parameters:\n        - in: query\n      responses:\n        '204':\n          description: none\n",
    );
    assert_eq!(
        invalid,
        vec![row("error", "parameter-invalid", &["GET /a"], 10)]
    );
}

#[test]
fn json_definitions_have_lines_too() {
    let source =
        "{\n  \"openapi\": \"3.0.0\",\n  \"info\": {\"title\": \"A\"},\n  \"paths\": {}\n}";
    assert_eq!(findings(source), vec![row("error", "info-version", &[], 3)]);
}

#[test]
fn the_outline_lists_paths_operations_and_schemas() {
    let outline = &inspect_source(VALID)["outline"];
    assert_eq!(outline["title"], "Orders");
    let paths: Vec<&str> = outline["paths"]
        .as_array()
        .unwrap()
        .iter()
        .map(|p| p["path"].as_str().unwrap())
        .collect();
    assert_eq!(paths, ["/orders", "/orders/{orderId}"]);
    let list = &outline["paths"][0]["operations"][0];
    assert_eq!(list["method"], "get");
    assert_eq!(list["summary"], "List orders");
    assert_eq!(list["line"], 9);
    assert_eq!(
        list["parameters"],
        json!([{"name": "status", "in": "query", "required": false, "type": "string",
                "pointer": "/paths/~1orders/get/parameters/0", "line": 13}])
    );
    assert_eq!(list["responses"][0]["schema"], "Order[]");
    let create = &outline["paths"][0]["operations"][1];
    assert_eq!(create["requestBody"]["media"], json!(["application/json"]));
    assert_eq!(create["requestBody"]["schema"], "Order");
    let one = &outline["paths"][1]["operations"][0];
    // A shared path parameter, followed to its definition.
    assert_eq!(one["parameters"][0]["name"], "orderId");
    assert_eq!(
        one["parameters"][0]["pointer"],
        "/components/parameters/OrderId"
    );
    assert_eq!(one["responses"][1]["status"], "404");
    assert_eq!(
        outline["schemas"],
        json!([{"name": "Order", "type": "object",
        "pointer": "/components/schemas/Order", "line": 82}])
    );
}

/// The changes of one endpoint as `(rule, params, breaking)`.
fn changes_of(diff: &Value, method: &str, path: &str) -> Vec<(String, Vec<String>, bool)> {
    diff["changed"]
        .as_array()
        .unwrap()
        .iter()
        .find(|entry| entry["method"] == method && entry["path"] == path)
        .map(|entry| {
            entry["changes"]
                .as_array()
                .unwrap()
                .iter()
                .map(|change| {
                    (
                        change["rule"].as_str().unwrap().to_string(),
                        change["params"]
                            .as_array()
                            .unwrap()
                            .iter()
                            .map(|p| p.as_str().unwrap().to_string())
                            .collect(),
                        change["breaking"].as_bool().unwrap(),
                    )
                })
                .collect()
        })
        .unwrap_or_default()
}
fn change(rule: &str, params: &[&str], breaking: bool) -> (String, Vec<String>, bool) {
    (
        rule.into(),
        params.iter().map(|p| p.to_string()).collect(),
        breaking,
    )
}

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

#[test]
fn local_references_resolve_and_cycles_stop() {
    let spec = Spec::from_value(json!({
        "a": {"$ref": "#/b"}, "b": {"$ref": "#/a"},
        "c~d": {"e/f": 1}, "space": {"x y": 2}
    }));
    let (value, _) = spec.resolve(&spec.root["a"], "/a");
    assert!(value.get("$ref").is_some());
    assert_eq!(spec.reference("#/c~0d/e~1f"), Some(&json!(1)));
    assert_eq!(spec.reference("#/space/x%20y"), Some(&json!(2)));
    assert_eq!(spec.reference("#"), Some(&spec.root));
    assert_eq!(spec.reference("other.yaml"), None);
    assert_eq!(spec.line("/a"), None);
    assert!(Spec::parse(&"a".repeat(MAX_SOURCE + 1)).is_err());
}

#[test]
fn every_rule_has_its_message_in_both_languages() {
    let messages = [
        include_str!("../../../../../src/app/infrastructure/i18n/en.json"),
        include_str!("../../../../../src/app/infrastructure/i18n/es.json"),
    ];
    let rules = |source: &str| -> Vec<String> {
        source
            .split('"')
            .skip(1)
            .step_by(2)
            .filter(|text| {
                text.len() > 3
                    && text.contains('-')
                    && text
                        .chars()
                        .all(|c| c.is_ascii_lowercase() || c == '-' || c.is_ascii_digit())
                    && *text != "kebab-case"
            })
            .map(String::from)
            .collect()
    };
    for (prefix, source) in [
        ("lint", include_str!("lint.rs")),
        ("diff", include_str!("diff.rs")),
    ] {
        let found = rules(source);
        assert!(found.len() > 10, "{prefix}: {found:?}");
        for rule in found {
            for language in messages {
                assert!(
                    language.contains(&format!("\"{prefix}.{rule}\"")),
                    "{prefix}.{rule} has no message"
                );
            }
        }
    }
    for language in messages {
        assert!(language.contains("\"lint.parse\""));
    }
}
