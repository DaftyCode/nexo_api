use super::*;
#[test]
fn methods_and_query_encoding() {
    assert_eq!(http_method("post").unwrap(), "POST");
    assert!(http_method("GET; rm -rf").is_err());
    assert_eq!(encode_query_part("{{tenant}}"), "{{tenant}}");
    assert_eq!(encode_query_part("a b&{{x}}"), "a%20b%26{{x}}");
    assert_eq!(encode_component("é"), "%C3%A9");
}
#[test]
fn converts_simple_requests() {
    let item = request_item(&json!({
        "url": "https://x.test", "method": "post",
        "headers": [{"key": "A", "value": "1", "enabled": true}, {"key": "B", "value": "2", "enabled": false}],
        "query": [{"key": "q", "value": "{{v}}", "enabled": true}],
        "auth": {"type": "bearer", "token": "{{token}}"},
        "body": "{}", "tests": "pm.test()"
    }))
    .unwrap();
    assert_eq!(item["request"]["url"], "https://x.test?q={{v}}");
    assert_eq!(item["request"]["method"], "POST");
    assert_eq!(item["request"]["header"].as_array().unwrap().len(), 1);
    assert_eq!(item["request"]["auth"]["bearer"][0]["value"], "{{token}}");
    assert_eq!(item["event"][0]["listen"], "test");
    let inherit = request_item(&json!({"url": "x", "auth": {"type": "inherit"}})).unwrap();
    assert!(inherit["request"].get("auth").is_none());
    let form = request_item(
        &json!({"url": "x", "method": "POST", "bodyMode": "formdata", "form": [
            {"key": "note", "value": "hi", "enabled": true},
            {"key": "avatar", "type": "file", "src": "a.png", "enabled": true}
        ]}),
    )
    .unwrap();
    assert_eq!(
        form["request"]["body"]["formdata"],
        json!([
            {"key": "note", "value": "hi", "type": "text"},
            {"key": "avatar", "type": "file", "src": "a.png"}
        ])
    );
}
#[test]
fn nests_a_request_inside_its_ancestors() {
    let collection = as_collection(&json!({
        "request": {"name": "Leaf", "url": "http://x"},
        "context": {"ancestors": [{"name": "Root", "variable": [{"key": "a", "value": "1"}]}, {"name": "Folder"}]}
    }))
    .unwrap();
    assert_eq!(collection["variable"][0]["key"], "a");
    assert_eq!(collection["item"][0]["name"], "Folder");
    assert_eq!(collection["item"][0]["item"][0]["name"], "Leaf");
}
#[test]
fn fills_path_variables_like_postman() {
    let url = json!({
        "raw": "http://localhost:8080/v1/orders/:order/items/:empty?status=:order#:order",
        "variable": [{"key": "order", "value": "1234567"}, {"key": "empty", "value": ""}]
    });
    // The port and the query keep their colons; a variable without a value stays.
    assert_eq!(
        request_url(&url),
        "http://localhost:8080/v1/orders/1234567/items/:empty?status=:order#:order"
    );
    let built = json!({
        "protocol": "https", "host": ["api", "test"], "path": ["users", ":id"],
        "variable": [{"key": "id", "value": "{{user}}"}]
    });
    assert_eq!(request_url(&built), "https://api.test/users/{{user}}");
    assert_eq!(
        fill_path_variables("/a/:id", &json!([{"key": "id", "value": 7}])),
        "/a/7"
    );
    assert_eq!(request_url(&json!("http://x/:id")), "http://x/:id");
}
#[test]
fn builds_urls_from_objects() {
    assert_eq!(
        request_url(
            &json!({"protocol": "http", "host": ["api", "test"], "port": "8080", "path": ["v1", "users"], "query": [{"key": "a", "value": "b c"}]})
        ),
        "http://api.test:8080/v1/users?a=b%20c"
    );
}
