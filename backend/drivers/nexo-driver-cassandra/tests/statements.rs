//! Statements of the Cassandra module against the fixture's node: rows read by the driver's
//! pages, and the commands of cqlsh (`CONSISTENCY`, `TRACING`).
mod common;

use common::{driver, params, run};
use nexo_driver_sdk::statements::{ExecuteParams, FetchParams};

#[tokio::test]
async fn rows_are_read_by_pages_of_the_driver() {
    let connect = fixture!(params("pages"));
    let client = driver();
    client.connect(&connect).await.unwrap();
    let first = run(&client, "pages", "SELECT * FROM shop.readings")
        .await
        .unwrap();
    assert_eq!(first.rows.len(), 4);
    assert!(first.cursor.is_none());
    let paged = client
        .execute(&ExecuteParams {
            connection: "pages".into(),
            statement: "p".into(),
            sql: "SELECT * FROM shop.readings".into(),
            params: Vec::new(),
            page_rows: Some(1),
            max_rows: None,
        })
        .await
        .unwrap();
    let (mut total, mut cursor) = (paged.rows.len(), paged.cursor);
    while let Some(open) = cursor {
        let page = client
            .fetch(&FetchParams {
                connection: "pages".into(),
                cursor: open,
                page_rows: Some(1),
            })
            .await
            .unwrap();
        total += page.rows.len();
        cursor = page.cursor;
    }
    assert_eq!(total, 4);
}

#[tokio::test]
async fn the_commands_of_cqlsh_set_the_level_and_trace_the_statements() {
    let connect = fixture!(params("commands"));
    let client = driver();
    client.connect(&connect).await.unwrap();
    let said = run(&client, "commands", "CONSISTENCY").await.unwrap();
    assert_eq!(
        said.notices[0].message,
        "Current consistency level is LOCAL_ONE."
    );
    let said = run(&client, "commands", "CONSISTENCY ONE").await.unwrap();
    assert_eq!(said.notices[0].message, "Consistency level set to ONE.");
    // A level a single node cannot give is refused by the server.
    run(&client, "commands", "CONSISTENCY THREE").await.unwrap();
    let refused = run(
        &client,
        "commands",
        "SELECT id FROM shop.every_type WHERE id = 1",
    )
    .await;
    assert!(refused.is_err(), "{refused:?}");
    run(&client, "commands", "CONSISTENCY ONE").await.unwrap();
    run(&client, "commands", "TRACING ON").await.unwrap();
    let traced = run(
        &client,
        "commands",
        "SELECT id FROM shop.every_type WHERE id = 1",
    )
    .await
    .unwrap();
    assert_eq!(traced.rows.len(), 1);
    assert!(
        traced
            .notices
            .iter()
            .any(|notice| notice.message.starts_with("Trace ")),
        "{:?}",
        traced.notices
    );
    run(&client, "commands", "TRACING OFF").await.unwrap();
    let plain = run(
        &client,
        "commands",
        "SELECT id FROM shop.every_type WHERE id = 1",
    )
    .await
    .unwrap();
    assert!(plain.notices.is_empty(), "{:?}", plain.notices);
}
