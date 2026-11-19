use super::*;

fn response(status: u64, headers: Value, body: &str) -> Value {
    json!({"status": status, "statusText": "OK", "headers": headers, "body": body})
}

#[test]
fn shows_exactly_what_changed_in_two_json_responses() {
    let source = response(
        200,
        json!([{"key": "Content-Type", "value": "application/json"}, {"key": "Date", "value": "Tue"}]),
        r#"{"id": 1, "name": "Ana", "updatedAt": "2026-11-18", "tags": ["a"]}"#,
    );
    let target = response(
        200,
        json!([{"key": "content-type", "value": "application/json"}, {"key": "Date", "value": "Wed"}]),
        r#"{"tags": ["a", "b"], "name": "Eva", "id": 1, "updatedAt": "2026-11-19"}"#,
    );
    let compared = responses(&json!({"source": source, "target": target})).unwrap();
    assert_eq!(compared["same"], false);
    assert_eq!(compared["status"]["same"], true);
    assert_eq!(
        compared["headers"],
        json!([{"name": "Date", "source": "Tue", "target": "Wed"}])
    );
    let body = &compared["body"];
    assert_eq!(body["format"], "json");
    assert_eq!(body["complete"], true);
    assert_eq!(
        body["differences"],
        json!([
            {"path": "$.name", "source": "Ana", "target": "Eva"},
            {"path": "$.updatedAt", "source": "2026-11-18", "target": "2026-11-19"},
            {"path": "$.tags[1]", "target": "b"},
        ])
    );
    // Shown side by side with their fields in the same order.
    assert_eq!(
        body["target"],
        "{\n  \"id\": 1,\n  \"name\": \"Eva\",\n  \"tags\": [\n    \"a\",\n    \"b\"\n  ],\n  \"updatedAt\": \"2026-11-19\"\n}"
    );

    // Leaving out `updatedAt` and the date: only the name and the tag are left.
    let compared = responses(&json!({
        "source": source, "target": target,
        "ignore": ["updatedAt", " "], "ignoreHeaders": ["date"],
    }))
    .unwrap();
    assert_eq!(compared["headers"], json!([]));
    let paths: Vec<&str> = compared["body"]["differences"]
        .as_array()
        .unwrap()
        .iter()
        .map(|d| d["path"].as_str().unwrap())
        .collect();
    assert_eq!(paths, ["$.name", "$.tags[1]"]);
    assert!(
        !compared["body"]["source"]
            .as_str()
            .unwrap()
            .contains("updatedAt")
    );
}

#[test]
fn says_two_equal_responses_are_the_same() {
    let side = response(204, json!([{"key": "X", "value": "1"}]), "");
    let compared = responses(&json!({"source": side, "target": side})).unwrap();
    assert_eq!(compared["same"], true);
    assert_eq!(compared["body"]["format"], "text");
    assert_eq!(compared["body"]["same"], true);
}

#[test]
fn compares_other_bodies_as_text_and_binary_ones_whole() {
    let compared = responses(&json!({
        "source": response(200, json!([]), "<a>1</a>"),
        "target": {"status": 500, "statusText": "", "body": "{\"a\": 1}", "truncated": true},
    }))
    .unwrap();
    assert_eq!(
        compared["status"],
        json!({"same": false, "source": {"status": 200, "statusText": "OK"},
               "target": {"status": 500, "statusText": ""}})
    );
    let body = &compared["body"];
    assert_eq!(
        body,
        &json!({"format": "text", "same": false, "cut": true,
                "source": "<a>1</a>", "target": "{\"a\": 1}"})
    );

    let image = json!({"body": "iVBORw0K", "bodyEncoding": "base64"});
    let compared = responses(&json!({"source": image, "target": image})).unwrap();
    assert_eq!(
        compared["body"],
        json!({"format": "binary", "same": true, "cut": false})
    );
    let compared = responses(&json!({"source": image, "target": {"body": "iVBORw0K"}})).unwrap();
    assert_eq!(compared["body"]["same"], false);
}

#[test]
fn an_error_counts_as_part_of_the_status() {
    let failed = json!({"status": 0, "error": "Connection refused"});
    let compared = responses(&json!({"source": failed, "target": {"status": 0}})).unwrap();
    assert_eq!(compared["status"]["same"], false);
    assert_eq!(compared["status"]["source"]["error"], "Connection refused");
    assert!(compared["status"]["target"].get("error").is_none());
}

#[test]
fn joins_repeated_headers_and_leaves_out_names_with_wildcards() {
    let source = response(
        200,
        json!([
            {"key": "Set-Cookie", "value": "a=1"}, {"key": "set-cookie", "value": "b=2"},
            {"key": "X-Amzn-RequestId", "value": "1"}, {"key": "Only", "value": "x"},
        ]),
        "",
    );
    let target = response(
        200,
        json!([
            {"key": "Set-Cookie", "value": "a=1, b=2"}, {"key": "X-Amzn-RequestId", "value": "2"},
            {"key": "New", "value": "y"},
        ]),
        "",
    );
    let compared = responses(&json!({
        "source": source, "target": target, "ignoreHeaders": ["x-amzn-*"],
    }))
    .unwrap();
    assert_eq!(
        compared["headers"],
        json!([{"name": "Only", "source": "x"}, {"name": "New", "target": "y"}])
    );
    let ignored = |name: &str, pattern: &str| left_out(name, &[pattern.to_string()]);
    assert!(ignored("X-Request-Id", "*-id"));
    assert!(ignored("anything", "*"));
    assert!(ignored("abc", "a*b*c"));
    assert!(!ignored("ac", "a*b*c"));
    assert!(!ignored("ab", "ab*b"));
    assert!(!ignored("Dates", "date"));
}

#[test]
fn refuses_wrong_or_too_many_paths_to_leave_out() {
    let side = response(200, json!([]), "{}");
    let error = responses(&json!({"source": side, "target": side, "ignore": ["a..b"]}));
    assert!(error.unwrap_err().to_string().contains("a..b"));
    let many: Vec<String> = (0..=MAX_IGNORED).map(|n| format!("f{n}")).collect();
    let error = responses(&json!({"source": side, "target": side, "ignoreHeaders": many}));
    assert!(error.is_err());
    let long = "x".repeat(MAX_IGNORED_TEXT + 1);
    let error = responses(&json!({"source": side, "target": side, "ignore": [long]}));
    assert!(error.is_err());
}
