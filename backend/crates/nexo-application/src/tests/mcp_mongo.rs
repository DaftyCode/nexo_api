//! MongoDB for MCP agents: only the connections the person exposed, only reads, bounded
//! answers and hidden fields masked.
use crate::testing::*;

fn saved(fake: &Fake, id: &str, name: &str, value: Value) {
    fake.documents.lock().unwrap().push(Document {
        id: DocumentId::parse(id).unwrap(),
        workspace_id: WorkspaceId::parse("local").unwrap(),
        kind: DocumentKind::Connection,
        name: name.into(),
        revision: 1,
        updated_at: 0,
        value,
    });
}

async fn tool(application: &Application, name: &str, arguments: Value) -> (bool, Value) {
    let reply = application
        .mcp(json!({"jsonrpc": "2.0", "id": 1, "method": "tools/call",
                     "params": {"name": name, "arguments": arguments}}))
        .await
        .body
        .unwrap();
    let result = &reply["result"];
    let text = result["content"][0]["text"].as_str().unwrap_or_default();
    (
        result["isError"] == true,
        serde_json::from_str(text).unwrap_or(json!(text)),
    )
}

fn application_with_connections() -> (Application, Arc<Fake>) {
    let (application, fake) = application();
    saved(
        &fake,
        "c1",
        "Shop",
        json!({"uri": "mongodb://db.test", "mcp": true, "mcpHidden": ["email"]}),
    );
    saved(
        &fake,
        "c2",
        "Private",
        json!({"uri": "mongodb://private.test"}),
    );
    (application, fake)
}

fn with(target: &Value, extra: Value) -> Value {
    let mut arguments = target.clone();
    arguments
        .as_object_mut()
        .unwrap()
        .extend(extra.as_object().unwrap().clone());
    arguments
}

#[tokio::test]
async fn agents_see_only_the_exposed_connections() {
    let (application, _) = application_with_connections();
    let (error, listed) = tool(&application, "mongo_list_connections", json!({})).await;
    assert!(!error);
    assert_eq!(listed, json!({"connections": ["Shop"]}));
    let (error, message) = tool(
        &application,
        "mongo_find",
        json!({"connection": "Private", "database": "shop", "collection": "orders"}),
    )
    .await;
    assert!(error);
    assert_eq!(
        message,
        "No MongoDB connection named Private is exposed to MCP"
    );
    let (error, databases) = tool(
        &application,
        "mongo_list_databases",
        json!({"connection": "Shop"}),
    )
    .await;
    assert!(!error);
    assert_eq!(databases["databases"][0]["name"], "shop");
}

#[tokio::test]
async fn reads_are_bounded_and_never_write() {
    let (application, fake) = application_with_connections();
    let target = json!({"connection": "Shop", "database": "shop", "collection": "orders"});
    let (error, found) = tool(
        &application,
        "mongo_find",
        with(&target, json!({"filter": {"a": 1}, "limit": 5000})),
    )
    .await;
    assert!(!error, "{found}");
    assert_eq!(found["truncated"], false);
    let request = fake.finds.lock().unwrap().remove(0);
    assert_eq!((request.limit, request.page_size), (Some(100), 100));
    assert_eq!(request.filter, Some(json!({"a": 1})));

    let (error, refused) = tool(
        &application,
        "mongo_aggregate",
        with(
            &target,
            json!({"pipeline": [{"$match": {}}, {"$out": "copy"}]}),
        ),
    )
    .await;
    assert!(error);
    assert!(refused.as_str().unwrap().contains("writes"), "{refused}");
    let (error, grouped) = tool(
        &application,
        "mongo_aggregate",
        with(
            &target,
            json!({"pipeline": [{"$group": {"_id": "$email"}}], "limit": 3}),
        ),
    )
    .await;
    assert!(!error);
    assert_eq!(grouped["documents"][0]["_id"], "A");
    let request = fake.aggregates.lock().unwrap().pop().unwrap();
    assert_eq!(request.pipeline.last().unwrap(), &json!({"$limit": 3}));

    let (error, schema) = tool(&application, "mongo_schema", target.clone()).await;
    assert!(!error, "{schema}");
    assert_eq!(schema["sampled"], 1);
    let (error, explained) = tool(
        &application,
        "mongo_explain",
        with(&target, json!({"filter": {"a": 1}})),
    )
    .await;
    assert!(!error);
    assert_eq!(
        explained["explain"]["queryPlanner"]["winningPlan"]["stage"],
        "COLLSCAN"
    );
    assert!(fake.writes.lock().unwrap().is_empty());
}

#[test]
fn hidden_fields_are_masked_at_any_depth() {
    let documents = vec![json!({
        "email": "a@b.c", "n": 1,
        "contact": {"email": "x", "phone": "1"},
        "list": [{"email": "y"}],
    })];
    let bounded = crate::mcp::mongo_bounded(documents, &["email".to_string()]);
    assert_eq!(
        bounded["documents"][0],
        json!({
            "email": "[hidden]", "n": 1,
            "contact": {"email": "[hidden]", "phone": "1"},
            "list": [{"email": "[hidden]"}],
        })
    );
    let many: Vec<Value> = (0..100)
        .map(|n| json!({"n": n, "text": "x".repeat(2_000)}))
        .collect();
    let bounded = crate::mcp::mongo_bounded(many, &[]);
    assert_eq!(bounded["truncated"], true);
    assert!(bounded["documents"].as_array().unwrap().len() < 40);
}

#[tokio::test]
async fn resources_describe_the_exposed_connections() {
    let (application, _) = application_with_connections();
    let call = |method: &str, params: Value| {
        application.mcp(json!({"jsonrpc": "2.0", "id": 1, "method": method, "params": params}))
    };
    let listed = call("resources/list", json!({})).await.body.unwrap();
    let uris: Vec<&str> = listed["result"]["resources"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|resource| resource["uri"].as_str())
        .collect();
    assert!(
        uris.contains(&"nexo://workspaces/local/mongo/Shop"),
        "{uris:?}"
    );
    assert!(!uris.iter().any(|uri| uri.contains("Private")));
    let overview = call(
        "resources/read",
        json!({"uri": "nexo://workspaces/local/mongo/Shop"}),
    )
    .await
    .body
    .unwrap();
    let text: Value =
        serde_json::from_str(overview["result"]["contents"][0]["text"].as_str().unwrap()).unwrap();
    assert_eq!(
        text,
        json!({"connection": "Shop", "databases": [{"database": "shop", "collections": ["shop-orders"]}]})
    );
    let schema = call(
        "resources/read",
        json!({"uri": "nexo://workspaces/local/mongo/Shop/shop/orders"}),
    )
    .await
    .body
    .unwrap();
    assert!(
        schema["result"]["contents"][0]["text"]
            .as_str()
            .unwrap()
            .contains("\"sampled\"")
    );
    let hidden = call(
        "resources/read",
        json!({"uri": "nexo://workspaces/local/mongo/Private"}),
    )
    .await
    .body
    .unwrap();
    assert!(hidden["error"].is_object());
}
