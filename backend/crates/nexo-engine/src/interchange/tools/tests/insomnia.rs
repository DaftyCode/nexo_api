//! Insomnia exports, v4 and v5.
use super::*;
use serde_json::{Value, json};

#[test]
fn insomnia_v4_keeps_folders_auth_bodies_and_environments() {
    let result = imported(include_str!("../fixtures/insomnia-v4.json"));
    assert_eq!(result["kind"], "collection");
    assert_eq!(result["name"], "Shop API");
    let collection = &result["value"];
    assert_eq!(
        row(&collection["variable"], "baseUrl"),
        "https://shop.example.com"
    );
    assert_eq!(row(&collection["variable"], "api.version"), "v2");
    let users = at(collection, &["Users"]);
    assert_eq!(users["auth"]["type"], "bearer");
    assert_eq!(row(&users["auth"]["bearer"], "token"), "{{token}}");
    assert_eq!(row(&users["variable"], "page"), "2");
    let list = at(collection, &["Users", "List users"]);
    let request = &list["request"];
    assert_eq!(request["url"]["raw"], "{{baseUrl}}/users?page={{page}}");
    assert_eq!(
        list["nexoDisabledQuery"],
        json!([{"key": "verbose", "value": "true"}])
    );
    assert_eq!(
        request["header"][0]["key"], "X-Team",
        "a folder's headers reach its requests"
    );
    assert!(
        request.get("auth").is_none(),
        "an empty authentication inherits"
    );
    assert!(script(list, "prerequest").contains("// insomnia.environment.set"));
    let create = &at(collection, &["Users", "Create user"])["request"];
    assert_eq!(row(&create["auth"]["basic"], "username"), "{{user}}");
    assert_eq!(create["body"]["options"]["raw"]["language"], "json");
    assert!(
        create["body"]["raw"]
            .as_str()
            .unwrap()
            .contains("\"name\": \"{{userName}}\"")
    );
    let avatar = &at(collection, &["Users", "Upload avatar"])["request"];
    assert_eq!(
        avatar["url"]["variable"],
        json!([{"key": "id", "value": "7"}])
    );
    assert_eq!(avatar["body"]["formdata"][1]["src"], "me.png");
    let login = &at(collection, &["Log in"])["request"];
    assert_eq!(login["auth"]["type"], "noauth");
    assert_eq!(login["body"]["urlencoded"][1]["disabled"], true);
    let products = &at(collection, &["Products"])["request"];
    assert_eq!(products["body"]["mode"], "graphql");
    assert!(
        products["body"]["graphql"]["variables"]
            .as_str()
            .unwrap()
            .contains("\"first\": 3")
    );
    assert_eq!(row(&products["auth"]["apikey"], "key"), "X-Api-Key");
    // The environment under the base one, with only its own values.
    let more = result["more"].as_array().unwrap();
    assert_eq!(more.len(), 1);
    assert_eq!(more[0]["kind"], "environment");
    assert_eq!(more[0]["value"]["name"], "Development");
    assert_eq!(row(&more[0]["value"]["values"], "token"), "dev-token");
    let report = &result["report"];
    assert_eq!(report["source"], "insomnia");
    assert_eq!(
        (report["requests"].clone(), report["folders"].clone()),
        (json!(5), json!(1))
    );
    assert_eq!(report["environments"], 1);
    for (code, item) in [
        ("script", "List users"),
        ("script", "Users"),
        ("templateTag", "Create user"),
        ("file", "Upload avatar"),
        ("unsupported", "Stock stream"),
    ] {
        assert!(
            noted(&result, code, item),
            "{code} {item}: {:?}",
            codes(&result)
        );
    }
}

#[test]
fn insomnia_v5_yaml_reads_collections_of_insomnia_11() {
    let result = imported(include_str!("../fixtures/insomnia-v5.yaml"));
    let collection = &result["value"];
    assert_eq!(collection["info"]["name"], "Orders API");
    assert_eq!(collection["info"]["description"], "Orders of the shop.");
    assert_eq!(collection["auth"]["type"], "bearer");
    assert!(script(collection, "prerequest").contains("// insomnia.request.addHeader"));
    let orders = at(collection, &["Orders"]);
    assert_eq!(orders["auth"]["type"], "digest");
    assert_eq!(row(&orders["variable"], "order-id"), "41");
    let get = at(collection, &["Orders", "Get order"]);
    let request = &get["request"];
    assert_eq!(
        request["url"]["raw"],
        "{{baseUrl}}/orders/{{order-id}}?expand=items"
    );
    assert_eq!(request["auth"]["type"], "awsv4");
    assert_eq!(row(&request["auth"]["awsv4"], "accessKey"), "{{awsKey}}");
    let headers: Vec<&Value> = request["header"]
        .as_array()
        .unwrap()
        .iter()
        .map(|h| &h["key"])
        .collect();
    assert_eq!(
        headers,
        [&json!("X-Client"), &json!("X-Source"), &json!("Accept")]
    );
    assert!(script(get, "test").contains("// insomnia.environment.set('orderId', body.id);"));
    let upload = &at(collection, &["Orders", "Upload receipt"])["request"];
    assert_eq!(
        upload["body"],
        json!({"mode": "file", "file": {"src": "receipt.pdf"}})
    );
    let health = &at(collection, &["Health"])["request"];
    assert_eq!(
        (health["method"].clone(), health["body"]["raw"].clone()),
        (json!("HEAD"), json!("ping"))
    );
    let staging = &result["more"][0]["value"];
    assert_eq!(staging["name"], "Staging");
    let password = staging["values"]
        .as_array()
        .unwrap()
        .iter()
        .find(|v| v["key"] == "password")
        .unwrap();
    assert_eq!(password["type"], "secret");
    assert!(noted(&result, "unsupported", "Live orders"));
}

#[test]
fn insomnia_environment_exports_become_environments() {
    let result = imported(
        "type: environment.insomnia.rest/5.0\nname: Globals\nenvironments:\n  name: Base\n  data: {host: a.test}\n  subEnvironments:\n    - name: Prod\n      data: {host: b.test}\n",
    );
    assert_eq!(result["kind"], "environment");
    assert_eq!(
        result["value"],
        json!({"name": "Base", "values": [{"key": "host", "value": "a.test", "enabled": true}]})
    );
    assert_eq!(result["more"][0]["name"], "Prod");
    assert_eq!(result["report"]["environments"], 2);
}
