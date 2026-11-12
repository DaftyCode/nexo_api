//! Engine operations, workspaces, history and the MCP server over the use cases.
use crate::testing::*;

#[tokio::test]
async fn execute_strips_internal_fields_and_resolves_secrets() {
    let (application, fake) = application();
    application
        .execute(
            Operation::Request,
            json!({
                "workspace": "local",
                "request": {"url": "{{vault:key}}"},
                "resolvedSecrets": {"forged": "x"},
                "secretHosts": {"key": []},
                "secretNames": ["other"],
                "scope": "workspace:other",
                "egressLoopbackPorts": [22]
            }),
        )
        .await
        .unwrap();
    let (_, payload) = fake.executed.lock().unwrap()[0].clone();
    assert_eq!(payload["resolvedSecrets"], json!({"key": "secret-of-key"}));
    assert!(payload.get("secretNames").is_none());
    assert!(
        payload.get("secretHosts").is_none(),
        "only the engine sets it"
    );
    assert!(payload.get("scope").is_none());
    assert!(payload.get("egressLoopbackPorts").is_none());
}

#[tokio::test]
async fn secrets_need_a_value_or_valid_allowed_domains() {
    let (application, _) = application();
    assert!(application.put_secret("api", None, None).await.is_err());
    assert!(
        application
            .put_secret("api", None, Some(&["https://api.example.com/".into()]))
            .await
            .is_err()
    );
    application
        .put_secret("api", None, Some(&["*.example.com, api.test".into()]))
        .await
        .unwrap();
    application
        .put_secret("api", Some("v"), None)
        .await
        .unwrap();
}

#[tokio::test]
async fn a_deleted_oauth2_token_is_left_to_the_engine_but_other_secrets_must_exist() {
    let (application, fake) = application();
    application
        .execute(
            Operation::Request,
            json!({
                "workspace": "local",
                "request": {"url": "https://x", "auth": {"type": "oauth2", "oauth2": [
                    {"key": "accessToken", "value": "{{vault:nexo-oauth2:deleted}}"}
                ]}},
            }),
        )
        .await
        .unwrap();
    let (_, payload) = fake.executed.lock().unwrap()[0].clone();
    assert_eq!(payload["resolvedSecrets"], json!({}));
    let error = application
        .execute(
            Operation::Request,
            json!({"workspace": "local", "request": {"url": "{{vault:deleted-key}}"}}),
        )
        .await
        .unwrap_err();
    assert!(error.to_string().contains("Secret not found"));
}

#[tokio::test]
async fn datasets_are_scoped_to_an_existing_workspace() {
    let (application, fake) = application();
    application
        .execute(
            Operation::DatasetQuery,
            json!({"workspace": "local", "id": "d", "sql": "SELECT 1"}),
        )
        .await
        .unwrap();
    assert_eq!(
        fake.executed.lock().unwrap()[0].1["scope"],
        "workspace:local"
    );
    assert!(matches!(
        application
            .execute(
                Operation::DatasetQuery,
                json!({"workspace": "missing", "id": "d", "sql": "SELECT 1"})
            )
            .await,
        Err(Error::NotFound)
    ));
    assert!(
        application
            .execute(Operation::CookiesList, json!({}))
            .await
            .is_err(),
        "workspace data needs a workspace"
    );
}

#[tokio::test]
async fn history_is_pruned_and_the_last_workspace_is_kept() {
    let (application, fake) = application();
    application
        .save_document(Document {
            id: DocumentId::parse("h").unwrap(),
            workspace_id: WorkspaceId::parse("local").unwrap(),
            kind: DocumentKind::History,
            name: "GET /".into(),
            revision: 0,
            updated_at: 0,
            value: json!({}),
        })
        .await
        .unwrap();
    assert_eq!(fake.pruned.lock().unwrap().as_slice(), [HISTORY_LIMIT]);
    let local = WorkspaceId::parse("local").unwrap();
    assert!(matches!(
        application.delete_workspace(&local).await,
        Err(Error::Validation(_))
    ));
    application.create_workspace("other").await.unwrap();
    application.delete_workspace(&local).await.unwrap();
}

#[tokio::test]
async fn mcp_initializes_lists_tools_and_calls_use_cases() {
    let (application, fake) = application();
    let reply = application
        .mcp(json!({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": "2024-11-05"}}))
        .await;
    assert!(reply.session.is_some());
    assert_eq!(
        reply.body.unwrap()["result"]["protocolVersion"],
        "2024-11-05"
    );
    let notification = application
        .mcp(json!({"jsonrpc": "2.0", "method": "notifications/initialized"}))
        .await;
    assert_eq!(notification, mcp::Reply::default());
    let batch = application
        .mcp(json!([
            {"jsonrpc": "2.0", "id": 2, "method": "tools/list"},
            {"jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": {"name": "send_request", "arguments": {"request": {"url": "http://x"}}}},
            {"jsonrpc": "2.0", "id": 4, "method": "tools/call", "params": {"name": "send_request", "arguments": {}}},
            {"jsonrpc": "2.0", "id": 5, "method": "unknown"}
        ]))
        .await
        .body
        .unwrap();
    assert_eq!(batch[0]["result"]["tools"].as_array().unwrap().len(), 2);
    assert_eq!(batch[1]["result"]["isError"], false);
    assert_eq!(batch[2]["result"]["isError"], true);
    assert_eq!(batch[3]["error"]["code"], -32601);
    assert_eq!(fake.executed.lock().unwrap()[0].0, "request");
}
