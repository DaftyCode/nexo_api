//! Data masking: saved sets of a workspace given to the engine, and the sets for agents
//! applied to everything MCP agents read.
use crate::testing::*;

fn saved(fake: &Fake, id: &str, kind: DocumentKind, workspace: &str, value: Value) {
    fake.documents.lock().unwrap().push(Document {
        id: DocumentId::parse(id).unwrap(),
        workspace_id: WorkspaceId::parse(workspace).unwrap(),
        kind,
        name: id.into(),
        revision: 1,
        updated_at: 1,
        value,
    });
}

async fn tool(application: &Application, name: &str, arguments: Value) -> Value {
    let reply = application
        .mcp(json!({"jsonrpc": "2.0", "id": 1, "method": "tools/call",
                     "params": {"name": name, "arguments": arguments}}))
        .await
        .body
        .unwrap();
    let text = reply["result"]["content"][0]["text"]
        .as_str()
        .unwrap_or_default();
    serde_json::from_str(text).unwrap_or(json!(text))
}

#[tokio::test]
async fn a_saved_set_masks_with_its_rules() {
    let (application, fake) = application();
    let rules = json!([{"path": "email", "method": "hide"}]);
    saved(
        &fake,
        "m1",
        DocumentKind::Masking,
        "local",
        json!({"rules": rules}),
    );
    let masked = application
        .execute(
            Operation::MaskApply,
            json!({"workspace": "local", "set": "m1", "documents": [{"email": "a@b.c", "id": 1}]}),
        )
        .await
        .unwrap();
    assert_eq!(masked, json!({"documents": [{"email": "****", "id": 1}]}));
    let sent = fake.executed.lock().unwrap().last().cloned().unwrap();
    assert_eq!(sent.0, "mask.apply");
    assert_eq!(sent.1["rules"], rules);
    assert!(sent.1.get("set").is_none());
}

#[tokio::test]
async fn sets_of_other_kinds_or_workspaces_are_not_found() {
    let (application, fake) = application();
    fake.workspaces.lock().unwrap().push(workspace("team"));
    saved(
        &fake,
        "m1",
        DocumentKind::Masking,
        "team",
        json!({"rules": []}),
    );
    saved(
        &fake,
        "c1",
        DocumentKind::Collection,
        "local",
        json!({"item": []}),
    );
    for set in ["m1", "c1"] {
        let result = application
            .execute(
                Operation::MaskApply,
                json!({"workspace": "local", "set": set, "documents": []}),
            )
            .await;
        assert!(matches!(result, Err(Error::NotFound)), "{set}");
    }
    let result = application
        .execute(
            Operation::MaskApply,
            json!({"workspace": "local", "documents": []}),
        )
        .await;
    assert!(matches!(result, Err(Error::Validation(message)) if message == "Choose a masking set"));
    // Unsaved rules can be tried before saving them.
    let tried = application
        .execute(
            Operation::MaskApply,
            json!({"workspace": "local", "rules": [{"path": "a", "method": "remove"}], "documents": [{"a": 1}]}),
        )
        .await
        .unwrap();
    assert_eq!(tried, json!({"documents": [{}]}));
}

#[tokio::test]
async fn agents_read_through_the_sets_marked_for_them() {
    let (application, fake) = application();
    saved(
        &fake,
        "c1",
        DocumentKind::Connection,
        "local",
        json!({"uri": "mongodb://db.test", "mcp": true}),
    );
    saved(
        &fake,
        "m1",
        DocumentKind::Masking,
        "local",
        json!({"agents": true, "rules": [{"path": "$oid", "method": "hide"}]}),
    );
    saved(
        &fake,
        "m2",
        DocumentKind::Masking,
        "local",
        json!({"rules": [{"path": "email", "method": "hide"}]}),
    );
    let target = json!({"connection": "c1", "database": "shop", "collection": "orders"});
    let found = tool(&application, "mongo_find", target.clone()).await;
    assert_eq!(found["documents"], json!([{"_id": {"$oid": "****"}}]));
    // A response's JSON body is masked by field; one that is not JSON is withheld.
    let sets = json!({"agents": true, "rules": [{"path": "email", "method": "hide"}]});
    fake.documents.lock().unwrap()[2].value = sets;
    let sent = tool(
        &application,
        "send_request",
        json!({"request": {"url": "https://json.test"}}),
    )
    .await;
    let body: Value = serde_json::from_str(sent["body"].as_str().unwrap()).unwrap();
    assert_eq!(body, json!({"email": "****", "id": 7}));
    let text = tool(
        &application,
        "send_request",
        json!({"request": {"url": "https://text.test"}}),
    )
    .await;
    assert_eq!(text["body"], "[withheld: only JSON bodies can be masked]");
}

#[tokio::test]
async fn without_sets_for_agents_nothing_changes() {
    let (application, fake) = application();
    saved(
        &fake,
        "m1",
        DocumentKind::Masking,
        "local",
        json!({"rules": [{"path": "email", "method": "hide"}]}),
    );
    let sent = tool(
        &application,
        "send_request",
        json!({"request": {"url": "https://json.test"}}),
    )
    .await;
    assert_eq!(sent["body"], r#"{"email":"ana@corp.com","id":7}"#);
    assert!(
        !fake
            .executed
            .lock()
            .unwrap()
            .iter()
            .any(|(operation, _)| operation == "mask.apply")
    );
}

#[tokio::test]
async fn the_last_execution_shared_with_agents_is_masked() {
    let (application, fake) = application();
    saved(
        &fake,
        "m1",
        DocumentKind::Masking,
        "local",
        json!({"agents": true, "rules": [{"path": "email", "method": "hide"}]}),
    );
    saved(
        &fake,
        "h1",
        DocumentKind::History,
        "local",
        json!({"request": {"url": "https://x.test"}, "response": {"status": 200, "body": "{\"email\":\"ana@corp.com\"}"}}),
    );
    let reply = application
        .mcp(
            json!({"jsonrpc": "2.0", "id": 1, "method": "resources/read",
                     "params": {"uri": "nexo://workspaces/local/history/latest"}}),
        )
        .await
        .body
        .unwrap();
    let text = reply["result"]["contents"][0]["text"].as_str().unwrap();
    assert!(!text.contains("ana@corp.com"), "{text}");
    assert!(text.contains("****"));
}
