use super::*;
use crate::mcp::PROTOCOL;

#[tokio::test]
async fn initialize_declares_resources_and_prompts() {
    let application = application(false);
    let reply = call(
        &application,
        "initialize",
        json!({"protocolVersion": "2099-01-01"}),
    )
    .await;
    let result = &reply["result"];
    assert_eq!(result["protocolVersion"], PROTOCOL);
    assert_eq!(result["capabilities"]["resources"]["subscribe"], false);
    assert!(result["capabilities"]["prompts"].is_object());
}

#[tokio::test]
async fn resources_are_listed_for_every_workspace() {
    let application = application(false);
    let reply = call(&application, "resources/list", json!({})).await;
    let resources = reply["result"]["resources"].as_array().unwrap();
    let uris: Vec<&str> = resources
        .iter()
        .map(|r| r["uri"].as_str().unwrap())
        .collect();
    assert_eq!(
        uris,
        [
            "nexo://workspaces/local/collections/c1",
            "nexo://workspaces/local/environments/e1",
            "nexo://workspaces/local/globals",
            "nexo://workspaces/local/history/latest",
            "nexo://workspaces/w2/collections/c2",
        ]
    );
    assert_eq!(resources[0]["name"], "Main / Shop");
    assert_eq!(resources[0]["mimeType"], "application/json");
    let templates = call(&application, "resources/templates/list", json!({})).await;
    assert!(
        templates["result"]["resourceTemplates"][0]["uriTemplate"]
            .as_str()
            .unwrap()
            .ends_with("/collections/{collection}/requests/{request}")
    );
}

#[tokio::test]
async fn resources_are_read_without_secrets() {
    let application = application(false);
    let read = |uri: &str| call(&application, "resources/read", json!({"uri": uri}));

    let collection = read("nexo://workspaces/local/collections/c1").await;
    assert_eq!(
        collection["result"]["contents"][0]["uri"],
        "nexo://workspaces/local/collections/c1"
    );
    let shown = text(&collection);
    assert!(shown.contains("List orders"));
    assert!(!shown.contains("literal-token"));
    assert!(!shown.contains("s3cr3t-value"));
    assert!(shown.contains("uses [REDACTED] here"));

    let request = text(&read("nexo://workspaces/local/collections/c1/requests/r1").await);
    assert!(request.contains("{{base}}/orders"));
    let by_name =
        text(&read("nexo://workspaces/local/collections/c1/requests/List%20orders").await);
    assert_eq!(by_name, request);

    let environment = text(&read("nexo://workspaces/local/environments/e1").await);
    assert!(environment.contains("https://api.test"));
    assert!(!environment.contains("hunter22"));
    assert!(text(&read("nexo://workspaces/local/globals").await).contains("\"a\""));

    let latest = text(&read("nexo://workspaces/local/history/latest").await);
    assert!(latest.contains("boom"));
    assert!(!latest.contains("Bearer abc"));
    assert!(!latest.contains("s3cr3t-value"));

    for missing in [
        "nexo://workspaces/local/collections/missing",
        "nexo://workspaces/w2/collections/c1",
        "nexo://workspaces/local/environments/c1",
        "nexo://workspaces/local/collections/c1/requests/none",
        "nexo://workspaces/w2/globals",
        "nexo://workspaces/w2/history/latest",
        "https://example.com",
    ] {
        let reply = read(missing).await;
        assert_eq!(reply["error"]["code"], -32002, "{missing}");
        assert_eq!(reply["error"]["data"]["uri"], missing);
    }
}

#[tokio::test]
async fn nothing_is_shared_when_the_vault_cannot_be_checked() {
    let application = application(true);
    let reply = call(
        &application,
        "resources/read",
        json!({"uri": "nexo://workspaces/local/collections/c1"}),
    )
    .await;
    assert_eq!(reply["error"]["code"], -32603);
    assert_eq!(reply["error"]["message"], "An internal operation failed");
}

#[tokio::test]
async fn prompts_are_listed_and_embed_their_resource() {
    let application = application(false);
    let listed = call(&application, "prompts/list", json!({})).await;
    let names: Vec<&str> = listed["result"]["prompts"]
        .as_array()
        .unwrap()
        .iter()
        .map(|p| p["name"].as_str().unwrap())
        .collect();
    assert_eq!(
        names,
        ["write_tests", "explain_failure", "document_collection"]
    );

    let tests = call(
        &application,
        "prompts/get",
        json!({"name": "write_tests", "arguments": {"collection": "shop", "request": "List orders"}}),
    )
    .await;
    let messages = &tests["result"]["messages"];
    assert!(
        messages[0]["content"]["text"]
            .as_str()
            .unwrap()
            .contains("pm.test")
    );
    assert_eq!(
        messages[1]["content"]["resource"]["uri"],
        "nexo://workspaces/local/collections/c1/requests/r1"
    );

    let documented = call(
        &application,
        "prompts/get",
        json!({"name": "document_collection", "arguments": {"collection": "Team API"}}),
    )
    .await;
    let instruction = documented["result"]["messages"][0]["content"]["text"]
        .as_str()
        .unwrap();
    assert!(instruction.contains("\"Team API\" (0 requests)"));
    assert_eq!(
        documented["result"]["messages"][1]["content"]["resource"]["uri"],
        "nexo://workspaces/w2/collections/c2"
    );
    let shop = call(
        &application,
        "prompts/get",
        json!({"name": "document_collection", "arguments": {"collection": "c1", "workspace": "Main"}}),
    )
    .await;
    let embedded = shop["result"]["messages"][1]["content"]["resource"]["text"]
        .as_str()
        .unwrap();
    assert!(!embedded.contains("literal-token") && !embedded.contains("s3cr3t-value"));

    let failure = call(
        &application,
        "prompts/get",
        json!({"name": "explain_failure"}),
    )
    .await;
    let embedded = failure["result"]["messages"][1]["content"]["resource"]["text"]
        .as_str()
        .unwrap();
    assert!(embedded.contains("boom"));
    assert!(!embedded.contains("s3cr3t-value"));

    for (params, message) in [
        (
            json!({"name": "write_tests", "arguments": {"collection": "Shop"}}),
            "The argument request is required",
        ),
        (
            json!({"name": "write_tests", "arguments": {"collection": "Nope", "request": "x"}}),
            "There is no collection named Nope",
        ),
        (
            json!({"name": "write_tests", "arguments": {"collection": "Shop", "request": "Nope"}}),
            "There is no request named Nope in Shop",
        ),
        (
            json!({"name": "document_collection", "arguments": {"collection": "Shop", "workspace": "Elsewhere"}}),
            "There is no workspace named Elsewhere",
        ),
        (
            json!({"name": "explain_failure", "arguments": {"workspace": "w2"}}),
            "The workspace Team has no executions yet",
        ),
        (json!({"name": "unknown"}), "Unknown prompt"),
    ] {
        let reply = call(&application, "prompts/get", params.clone()).await;
        assert_eq!(reply["error"]["code"], -32602, "{params}");
        assert_eq!(reply["error"]["message"], message);
    }
}
