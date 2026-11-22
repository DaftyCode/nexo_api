//! SQL databases for MCP agents (DB-32): the tools by name, only the connections the person
//! exposed, each call on a session of its own opened only to read and closed, and only
//! statements that read.
use crate::testing::{datasources::with_sources, *};

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

#[tokio::test]
async fn the_sql_tools_are_listed_by_name() {
    let (application, _, _) = with_sources(json!({}));
    let reply = application
        .mcp(json!({"jsonrpc": "2.0", "id": 1, "method": "tools/list"}))
        .await
        .body
        .unwrap();
    let names: Vec<&str> = reply["result"]["tools"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|tool| tool["name"].as_str())
        .filter(|name| name.starts_with("sql_"))
        .collect();
    assert_eq!(
        names,
        [
            "sql_list_connections",
            "sql_list_tables",
            "sql_describe_table",
            "sql_query",
            "sql_explain"
        ]
    );
}

#[tokio::test]
async fn only_exposed_connections_exist_and_each_call_reads_on_a_session_of_its_own() {
    let (hidden, _, _) = with_sources(json!({"host": "db.test"}));
    let (error, answer) = tool(
        &hidden,
        "sql_query",
        json!({"connection": "Shop", "sql": "select 1"}),
    )
    .await;
    assert!(error);
    assert_eq!(
        answer,
        json!("No SQL connection named Shop is exposed to MCP")
    );
    assert_eq!(
        tool(&hidden, "sql_list_connections", json!({})).await.1,
        json!({"connections": []})
    );

    let (application, _, sources) =
        with_sources(json!({"host": "db.test", "mcp": true, "mcpHidden": ["n"]}));
    let (_, listed) = tool(&application, "sql_list_connections", json!({})).await;
    assert_eq!(
        listed,
        json!({"connections": [{"name": "Shop", "driver": "postgres"}]})
    );
    // A MongoDB tool does not reach it.
    assert!(
        tool(
            &application,
            "mongo_list_databases",
            json!({"connection": "Shop"})
        )
        .await
        .0
    );

    let (error, answer) = tool(
        &application,
        "sql_query",
        json!({"connection": "Shop", "sql": "select n from t", "limit": 1}),
    )
    .await;
    assert!(!error, "{answer}");
    // `n` is hidden, its origin unknown; one row of two, so it says it was cut.
    assert_eq!(
        answer,
        json!({"rows": [{"n": "[hidden]"}], "truncated": true, "columns": ["n"]})
    );
    let connected = sources.connected.lock().unwrap().clone();
    assert!(connected[0].0.starts_with("mcp-"));
    assert!(connected[0].1.read_only, "opened only to read");
    assert_eq!(
        sources.disconnected.lock().unwrap().clone(),
        [connected[0].0.clone()]
    );
    let executed = sources.executed.lock().unwrap().clone();
    assert_eq!(executed[0].1.max_rows, Some(2));

    for sql in ["update t set n = 1", "drop table t", "begin"] {
        let (error, answer) = tool(
            &application,
            "sql_query",
            json!({"connection": "Shop", "sql": sql}),
        )
        .await;
        assert!(error, "{sql}");
        assert!(answer.as_str().unwrap().contains("only read"), "{answer}");
    }
    let (error, _) = tool(
        &application,
        "sql_describe_table",
        json!({"connection": "Shop"}),
    )
    .await;
    assert!(error, "a path is needed");
    let (error, _) = tool(&application, "sql_rename", json!({"connection": "Shop"})).await;
    assert!(error);
    let (error, tables) = tool(
        &application,
        "sql_list_tables",
        json!({"connection": "Shop"}),
    )
    .await;
    assert!(!error, "{tables}");
    assert_eq!(tables["connection"], "Shop");
}
