//! Hoppscotch and Thunder Client exports, and the syntax of their variables.
use super::super::report::Report;
use super::super::vars;
use super::*;
use serde_json::{Value, json};

#[test]
fn hoppscotch_collections_turn_their_variables_into_nexo_ones() {
    let result = imported(include_str!("../fixtures/hoppscotch-collections.json"));
    let collection = &result["value"];
    assert_eq!(collection["info"]["name"], "Books");
    assert_eq!(collection["auth"]["type"], "bearer");
    assert_eq!(row(&collection["auth"]["bearer"], "token"), "{{token}}");
    assert_eq!(row(&collection["variable"], "author"), "Herbert");
    let admin = at(collection, &["Admin"]);
    assert_eq!(row(&admin["auth"]["apikey"], "key"), "X-Admin-Key");
    assert_eq!(row(&admin["auth"]["apikey"], "in"), "header");
    let add = at(collection, &["Admin", "Add book"]);
    let request = &add["request"];
    assert_eq!(request["url"]["raw"], "{{baseUrl}}/books");
    assert!(request.get("auth").is_none());
    let headers: Vec<&Value> = request["header"]
        .as_array()
        .unwrap()
        .iter()
        .map(|h| &h["key"])
        .collect();
    assert_eq!(
        headers,
        [&json!("X-Client"), &json!("X-Area"), &json!("Content-Type")]
    );
    assert_eq!(request["body"]["raw"], "{\n  \"title\": \"{{title}}\"\n}");
    assert_eq!(
        script(add, "prerequest"),
        "pm.variables.set(\"title\", \"Dune\");"
    );
    assert!(script(add, "test").contains("// pw.test("));
    let cover = &at(collection, &["Admin", "Upload cover"])["request"];
    assert_eq!(cover["auth"]["type"], "noauth");
    assert_eq!(cover["body"]["formdata"][1]["type"], "file");
    let list = at(collection, &["List books"]);
    assert_eq!(
        list["request"]["url"]["raw"],
        "{{baseUrl}}/books?author={{author}}"
    );
    assert_eq!(
        list["nexoDisabledQuery"],
        json!([{"key": "draft", "value": "true"}])
    );
    assert!(list["request"].get("body").is_none());
    let search = &at(collection, &["Search"])["request"];
    let oauth2 = &search["auth"]["oauth2"];
    assert_eq!(row(oauth2, "grant_type"), "client_credentials");
    assert_eq!(row(oauth2, "accessTokenUrl"), "{{baseUrl}}/oauth/token");
    assert_eq!(row(oauth2, "clientSecret"), "{{clientSecret}}");
    let form: Vec<(&str, &str, bool)> = search["body"]["urlencoded"]
        .as_array()
        .unwrap()
        .iter()
        .map(|r| {
            (
                r["key"].as_str().unwrap(),
                r["value"].as_str().unwrap(),
                r["disabled"] == true,
            )
        })
        .collect();
    assert_eq!(
        form,
        [
            ("q", "{{author}}", false),
            ("page", "2", true),
            ("limit", "10", false)
        ]
    );
    assert_eq!(result["report"]["source"], "hoppscotch");
    assert_eq!(result["report"]["folders"], 1);
    assert!(noted(&result, "script", "List books"));
    assert!(noted(&result, "file", "Upload cover"));
}

#[test]
fn hoppscotch_environments_keep_their_current_values() {
    let result = imported(include_str!("../fixtures/hoppscotch-environments.json"));
    assert_eq!(result["kind"], "environment");
    let local = &result["value"];
    assert_eq!(row(&local["values"], "token"), "abc");
    assert_eq!(local["values"][1]["type"], "secret");
    assert_eq!(result["more"][0]["name"], "Old");
    assert_eq!(
        row(&result["more"][0]["value"]["values"], "baseUrl"),
        "http://old.example.com"
    );
}

#[test]
fn thunder_client_collections_keep_folders_and_path_parameters() {
    let result = imported(include_str!("../fixtures/thunder-collection.json"));
    let collection = &result["value"];
    assert_eq!(collection["info"]["name"], "Weather");
    assert_eq!(collection["auth"]["type"], "bearer");
    let names: Vec<&str> = collection["item"]
        .as_array()
        .unwrap()
        .iter()
        .map(|i| i["name"].as_str().unwrap())
        .collect();
    assert_eq!(names, ["Admin", "Forecast"]);
    let forecast = at(collection, &["Forecast"]);
    let request = &forecast["request"];
    assert_eq!(
        request["url"]["raw"],
        "{{baseUrl}}/cities/:city/forecast?days=3"
    );
    assert_eq!(
        request["url"]["variable"],
        json!([{"key": "city", "value": "madrid"}])
    );
    assert_eq!(
        forecast["nexoDisabledQuery"],
        json!([{"key": "units", "value": "metric"}])
    );
    assert_eq!(row(&request["header"], "X-Request-Id"), "{{$guid}}");
    assert_eq!(request["header"][3]["disabled"], true);
    assert_eq!(request["description"], "Three days of forecast.");
    let admin = at(collection, &["Admin"]);
    assert_eq!(
        row(&admin["auth"]["basic"], "password"),
        "{{adminPassword}}"
    );
    let add = &at(collection, &["Admin", "Add station"])["request"];
    assert!(add.get("auth").is_none());
    assert_eq!(
        add["body"]["raw"],
        "{\n  \"name\": \"Retiro\",\n  \"at\": {{$timestamp}}\n}"
    );
    assert_eq!(add["header"][1]["key"], "X-Area");
    let upload = &at(collection, &["Admin", "Upload readings"])["request"];
    assert_eq!(row(&upload["auth"]["bearer"], "prefix"), "Token");
    assert_eq!(upload["body"]["formdata"][1]["src"], "readings.csv");
    assert!(noted(&result, "tests", "Forecast"));
    assert!(noted(&result, "file", "Upload readings"));
    assert_eq!(result["report"]["source"], "thunder");
}

#[test]
fn thunder_client_environments_become_environments() {
    let result = imported(include_str!("../fixtures/thunder-environment.json"));
    assert_eq!(result["kind"], "environment");
    assert_eq!(result["name"], "Weather local");
    assert_eq!(row(&result["value"]["values"], "token"), "local-token");
}

#[test]
fn variables_of_each_tool_read_as_nexo_ones() {
    let mut report = Report::default();
    for (written, read) in [
        (
            "{{ _.host }}/{{_['a b']}}/{{ x }}",
            "{{host}}/{{_['a b']}}/{{x}}",
        ),
        ("{{ _[\"id\"] }} {{ now() }}", "{{id}} {{ now() }}"),
        ("unclosed {{ x", "unclosed {{ x"),
    ] {
        assert_eq!(vars::insomnia(written, "r", &mut report), read);
    }
    assert_eq!(
        vars::hoppscotch("<<a>>/<< b >>/<<not valid>>/<<x"),
        "{{a}}/{{b}}/<<not valid>>/<<x"
    );
    assert_eq!(
        vars::thunder("{{#guid}} {{#dateISO}} {{#other}} {{x}}"),
        "{{$guid}} {{$isoTimestamp}} {{#other}} {{x}}"
    );
    assert_eq!(
        vars::thunder_path("{{base}}/a/{id}/b/{ x }/{{c}}"),
        "{{base}}/a/:id/b/{ x }/{{c}}"
    );
}

#[test]
fn unknown_documents_and_empty_exports_are_refused() {
    for content in [
        r#"{"name": "x"}"#,
        r#"{"client": "Thunder Client", "collectionName": "x"}"#,
    ] {
        let result = super::super::super::import(&json!({"content": content}));
        if content.contains("Thunder") {
            assert_eq!(result.unwrap()["value"]["item"], json!([]));
        } else {
            assert!(
                result
                    .unwrap_err()
                    .to_string()
                    .contains("Unsupported import format")
            );
        }
    }
    let error =
        super::super::super::import(&json!({"content": "type: mock.insomnia.rest/5.0\nname: M\n"}))
            .unwrap_err();
    assert!(error.to_string().contains("nothing to import"));
}
