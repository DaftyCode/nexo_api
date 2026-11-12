use crate::mcp::{resources::*, share::*, uri::*};
use nexo_domain::WorkspaceId;
use serde_json::json;

#[test]
fn shared_documents_keep_references_and_hide_credentials() {
    let collection = json!({
        "info": {"name": "Shop"},
        "auth": {"type": "bearer", "bearer": [{"key": "token", "value": "abc123"}]},
        "variable": [
            {"key": "base", "value": "https://api.test"},
            {"key": "apiKey", "value": "k-1"},
            {"key": "hidden", "value": "s", "type": "secret"},
            {"key": "ref", "value": "{{vault:key}}", "type": "secret"},
        ],
        "nexoTransport": {"clientCertificate": "-----BEGIN"},
        "item": [{"id": "r1", "name": "Login", "request": {
            "header": [
                {"key": "Authorization", "value": "Basic dXNlcjpwYXNz"},
                {"key": "Accept", "value": "application/json"},
                {"key": "X-Api-Key", "value": "{{apiKey}}"},
            ],
            "auth": {"type": "hawk", "hawk": [{"key": "key", "value": "hk"}, {"key": "algorithm", "value": "sha256"}]},
        }}],
    });
    let shared = shareable(&collection);
    assert_eq!(shared["auth"]["bearer"][0]["value"], MASKED);
    let variables = &shared["variable"];
    assert_eq!(variables[0]["value"], "https://api.test");
    assert_eq!(variables[1]["value"], MASKED);
    assert_eq!(variables[2]["value"], MASKED);
    assert_eq!(variables[3]["value"], "{{vault:key}}");
    assert!(shared.get("nexoTransport").is_none());
    let request = &shared["item"][0]["request"];
    assert_eq!(request["header"][0]["value"], MASKED);
    assert_eq!(request["header"][1]["value"], "application/json");
    assert_eq!(request["header"][2]["value"], "{{apiKey}}");
    assert_eq!(request["auth"]["hawk"][0]["value"], MASKED);
    assert_eq!(request["auth"]["hawk"][1]["value"], "sha256");
    // History entries keep the interface's shape: `headers` and `values` rows.
    let entry = shareable(
        &json!({"request": {"headers": [{"key": "Cookie", "value": "a=b"}]},
        "environment": {"values": [{"key": "password", "value": "p"}]}}),
    );
    assert_eq!(entry["request"]["headers"][0]["value"], MASKED);
    assert_eq!(entry["environment"]["values"][0]["value"], MASKED);
}

#[test]
fn uris_round_trip_and_unknown_ones_are_refused() {
    let workspace = WorkspaceId::parse("my space").unwrap();
    let address = uri(
        &workspace,
        &["collections", &encode("c/1"), "requests", &encode("r 1")],
    );
    assert_eq!(
        address,
        "nexo://workspaces/my%20space/collections/c%2F1/requests/r%201"
    );
    assert_eq!(
        parse_uri(&address),
        Some(Resource::Request(
            workspace.clone(),
            "c/1".into(),
            "r 1".into()
        ))
    );
    assert_eq!(
        parse_uri("nexo://workspaces/local/history/latest"),
        Some(Resource::LastExecution(
            WorkspaceId::parse("local").unwrap()
        ))
    );
    for unknown in [
        "nexo://workspaces/local",
        "nexo://workspaces/local/runs/1",
        "nexo://workspaces/local/collections/%zz",
        "file:///etc/passwd",
        "nexo://workspaces//globals",
    ] {
        assert_eq!(parse_uri(unknown), None, "{unknown}");
    }
}

#[test]
fn requests_are_found_by_id_or_name_in_folders() {
    let items = json!([
        {"name": "Folder", "item": [{"id": "r2", "name": "Create order", "request": {}}]},
        {"id": "r1", "name": "List orders", "request": {}}
    ]);
    assert_eq!(find_request(&items, "r2").unwrap()["name"], "Create order");
    assert_eq!(find_request(&items, "list ORDERS").unwrap()["id"], "r1");
    assert!(find_request(&items, "Folder").is_none());
    assert_eq!(request_count(&items), 2);
}
