//! The assistant's tools: those of each place are offered, each one reads what it may and
//! masks it as for MCP agents, and what goes back to the model has no value of the vault.
use crate::testing::*;

fn document(id: &str, kind: DocumentKind, name: &str, value: Value) -> Document {
    Document {
        id: DocumentId::parse(id).unwrap(),
        workspace_id: WorkspaceId::parse("local").unwrap(),
        kind,
        name: name.into(),
        revision: 1,
        updated_at: 0,
        value,
    }
}

async fn tool(application: &Application, name: &str, context: Value, more: Value) -> Value {
    let mut payload = json!({"workspace": "local", "name": name, "context": context});
    if let (Some(payload), Some(more)) = (payload.as_object_mut(), more.as_object()) {
        payload.extend(more.clone());
    }
    application
        .execute(Operation::AiTool, payload)
        .await
        .unwrap()
}

#[tokio::test]
async fn the_tools_of_the_place_are_offered_and_their_answers_go_back_redacted() {
    let (application, fake) = application();
    fake.listed.lock().unwrap().push("db-password".into());
    application
        .execute(
            Operation::AiChat,
            json!({"provider": "anthropic", "model": "m", "tools": "sql",
                   "messages": [{"role": "user", "text": "Count"}]}),
        )
        .await
        .unwrap();
    let (_, sent) = fake.executed.lock().unwrap().remove(0);
    let names: Vec<&str> = sent["tools"]
        .as_array()
        .unwrap()
        .iter()
        .map(|tool| tool["name"].as_str().unwrap())
        .collect();
    assert!(names.contains(&"read_open") && names.contains(&"sql_query"));
    assert!(!names.contains(&"read_response") && !names.contains(&"mongo_find"));
    application
        .execute(
            Operation::AiContinue,
            json!({"id": "c1", "results": [{"id": "t1", "text": "pw secret-of-db-password"}]}),
        )
        .await
        .unwrap();
    let (operation, sent) = fake.executed.lock().unwrap().remove(0);
    assert_eq!(operation, "ai.continue");
    assert_eq!(sent["results"][0]["text"], "pw [redacted]");
}

#[tokio::test]
async fn what_is_open_is_read_as_agents_may_read_it() {
    let (application, fake) = application();
    fake.listed.lock().unwrap().push("db-password".into());
    let request = json!({"name": "Login", "request": {"method": "POST", "url": "https://api.test/login",
        "header": [{"key": "Authorization", "value": "Bearer abc-123"}],
        "auth": {"type": "bearer", "bearer": [{"key": "token", "value": "tok-123"}]},
        "body": {"mode": "raw", "raw": "{\"password\": \"secret-of-db-password\"}"}}});
    let open = tool(
        &application,
        "read_open",
        json!({"place": "request", "request": request, "error": "timeout"}),
        json!({}),
    )
    .await;
    let text = open["text"].as_str().unwrap();
    assert_eq!(open["error"], false);
    assert!(text.contains("https://api.test/login") && text.contains("timeout"));
    for secret in ["abc-123", "tok-123", "secret-of-db-password"] {
        assert!(!text.contains(secret), "{secret} in {text}");
    }
    assert!(text.contains("[REDACTED]"));
    // A connection agents may not read says how to allow it.
    let sql = tool(
        &application,
        "read_open",
        json!({"place": "sql", "connection": "Prod", "script": "SELECT 1"}),
        json!({}),
    )
    .await;
    assert!(
        sql["text"]
            .as_str()
            .unwrap()
            .contains("\"readableByTools\": false")
    );
    assert!(
        sql["text"]
            .as_str()
            .unwrap()
            .contains("Let MCP agents read it")
    );
    let nothing = tool(&application, "read_open", json!({}), json!({})).await;
    assert_eq!(nothing["error"], true);
}

#[tokio::test]
async fn a_response_is_read_without_its_credentials_and_its_body_can_stay_home() {
    let (application, _) = application();
    let response = json!({"status": 401, "statusText": "Unauthorized", "time": 12,
        "headers": [{"key": "Set-Cookie", "value": "sid=abc"}, {"key": "Content-Type", "value": "application/json"}],
        "body": "{\"error\": \"expired\"}", "request": {"url": "https://x"}, "cookies": [1]});
    let read = tool(
        &application,
        "read_response",
        json!({"response": response}),
        json!({}),
    )
    .await;
    let text = read["text"].as_str().unwrap();
    assert!(text.contains("expired") && text.contains("application/json") && text.contains("401"));
    assert!(!text.contains("sid=abc") && !text.contains("cookies") && !text.contains("https://x"));
    let kept = tool(
        &application,
        "read_response",
        json!({"response": response}),
        json!({"bodies": false}),
    )
    .await;
    assert!(!kept["text"].as_str().unwrap().contains("expired"));
    assert!(
        kept["text"]
            .as_str()
            .unwrap()
            .contains("keeps response bodies on this computer")
    );
    let none = tool(&application, "read_response", json!({}), json!({})).await;
    assert_eq!(none["error"], true);
    assert!(none["text"].as_str().unwrap().contains("send it first"));
}

#[tokio::test]
async fn the_requests_of_the_collection_are_listed_and_read() {
    let (application, fake) = application();
    fake.documents.lock().unwrap().push(document(
        "c1",
        DocumentKind::Collection,
        "Shop",
        json!({"item": [{"name": "Orders", "item": [
            {"id": "r1", "name": "List orders", "request": {"method": "GET", "url": {"raw": "{{base}}/orders"},
             "header": [{"key": "X-Api-Key", "value": "key-999"}]}}
        ]}]}),
    ));
    let context = json!({"collectionId": "c1"});
    let listed = tool(&application, "list_requests", context.clone(), json!({})).await;
    let text = listed["text"].as_str().unwrap();
    assert!(
        text.contains("List orders") && text.contains("Orders") && text.contains("{{base}}/orders")
    );
    let read = tool(
        &application,
        "read_request",
        context.clone(),
        json!({"input": {"name": "list orders"}}),
    )
    .await;
    assert!(read["text"].as_str().unwrap().contains("GET"));
    assert!(!read["text"].as_str().unwrap().contains("key-999"));
    let missing = tool(
        &application,
        "read_request",
        context,
        json!({"input": {"name": "Pay"}}),
    )
    .await;
    assert_eq!(missing["error"], true);
    let unsaved = tool(&application, "list_requests", json!({}), json!({})).await;
    assert!(
        unsaved["text"]
            .as_str()
            .unwrap()
            .contains("not saved in a collection")
    );
}

#[tokio::test]
async fn a_tool_never_reaches_what_agents_may_not_read() {
    let (application, _) = application();
    let query = tool(
        &application,
        "sql_query",
        json!({}),
        json!({"input": {"connection": "Prod", "sql": "SELECT 1"}}),
    )
    .await;
    assert_eq!(query["error"], true);
    assert!(query["text"].as_str().unwrap().contains("exposed"));
    let unknown = tool(&application, "send_request", json!({}), json!({})).await;
    assert_eq!(unknown["error"], true);
    assert!(
        unknown["text"]
            .as_str()
            .unwrap()
            .contains("is not a tool of Nexo")
    );
}
