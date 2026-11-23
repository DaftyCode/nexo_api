//! The connections the assistant reads: the one open beside the chat, which it reads first,
//! and those exposed to MCP; never another one, and an MCP agent never the open one.
use super::tools::{document, tool};
use crate::testing::*;

#[tokio::test]
async fn the_assistant_reads_the_connection_open_beside_it_and_those_exposed_to_mcp() {
    let (application, fake) = application();
    fake.documents.lock().unwrap().extend([
        document(
            "d1",
            DocumentKind::Connection,
            "Padel",
            json!({"driver": "postgres", "host": "localhost"}),
        ),
        document(
            "d2",
            DocumentKind::Connection,
            "Shared",
            json!({"driver": "postgres", "host": "localhost", "mcp": true}),
        ),
        document(
            "d3",
            DocumentKind::Connection,
            "Shop",
            json!({"uri": "mongodb://localhost"}),
        ),
        document(
            "d4",
            DocumentKind::Connection,
            "Private",
            json!({"driver": "postgres", "host": "localhost"}),
        ),
    ]);
    let beside = |place: &str, name: &str, id: &str| json!({"place": place, "connection": name, "connectionId": id});
    let open = tool(
        &application,
        "read_open",
        beside("sql", "Padel", "d1"),
        json!({}),
    )
    .await;
    assert!(
        open["text"]
            .as_str()
            .unwrap()
            .contains("\"readableByTools\": true")
    );
    // The connection open beside the chat and those exposed to MCP, never another one.
    let listed = tool(
        &application,
        "sql_list_connections",
        beside("sql", "Padel", "d1"),
        json!({}),
    )
    .await;
    let text = listed["text"].as_str().unwrap();
    assert_eq!(listed["error"], false);
    assert!(
        text.contains("Padel") && text.contains("Shared") && !text.contains("Private"),
        "{text}"
    );
    let mongo = tool(
        &application,
        "mongo_list_connections",
        beside("mongo", "Shop", "d3"),
        json!({}),
    )
    .await;
    assert!(mongo["text"].as_str().unwrap().contains("Shop"));
    let elsewhere = tool(
        &application,
        "sql_list_tables",
        beside("sql", "Padel", "d1"),
        json!({"input": {"connection": "Private"}}),
    )
    .await;
    assert_eq!(elsewhere["error"], true);
    assert!(
        elsewhere["text"]
            .as_str()
            .unwrap()
            .contains("neither the SQL connection open beside the assistant")
    );
    // An MCP agent reads what was exposed to it, never the connection beside the chat.
    let reply = application
        .mcp(json!({"jsonrpc": "2.0", "id": 1, "method": "tools/call",
                     "params": {"name": "sql_list_connections", "arguments": {}}}))
        .await
        .body
        .unwrap()
        .to_string();
    assert!(
        reply.contains("Shared") && !reply.contains("Padel"),
        "{reply}"
    );
}
