//! Linting and outlining definitions.
use super::super::*;
use super::*;

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
