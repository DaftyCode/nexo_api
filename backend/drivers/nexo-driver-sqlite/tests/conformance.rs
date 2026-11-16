//! The SDK's conformance checks on a file made in the test, and the sessions of SQLite: the
//! 100 000 numbers read by pages, a script's results, writes with their counts and rowids,
//! manual commit and where a syntax error is.
mod common;

use common::{Folder, SHOP, database, driver, params, run, single, statement};
use nexo_driver_sdk::{
    ErrorCode, Value,
    conformance::{Suite, check},
    statements::{FetchParams, TransactionAction, TransactionParams},
};
use nexo_driver_sqlite::SqliteDriver;

#[tokio::test]
async fn sqlite_passes_the_conformance_checks() {
    let folder = Folder::new("conformance");
    let path = database(&folder, "shop.db", SHOP);
    let suite = Suite {
        connect: params("conformance", &path),
        wrong_password: None,
        paged_sql: "SELECT n, label FROM numbers WHERE n <= 120 ORDER BY n".into(),
        paged_rows: 120,
        slow_sql: Some(
            "WITH RECURSIVE c(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM c) SELECT count(*) FROM c"
                .into(),
        ),
        invalid_sql: "SELECT 1 +".into(),
        values: vec![
            ("SELECT 9007199254740993".into(), Value::Integer(9_007_199_254_740_993)),
            ("SELECT 1.5".into(), Value::Float(1.5)),
            ("SELECT X'00FF'".into(), Value::bytes(&[0, 255])),
            ("SELECT NULL".into(), Value::Null),
            ("SELECT 'año'".into(), Value::Text("año".into())),
        ],
        rollback: Some((
            "INSERT INTO customers (email) VALUES ('rolled-back@example.com')".into(),
            "SELECT count(*) FROM customers".into(),
        )),
    };
    let failures = check(SqliteDriver::default(), suite).await;
    assert!(failures.is_empty(), "{failures:#?}");
}

#[tokio::test]
async fn reads_a_hundred_thousand_rows_by_pages() {
    let folder = Folder::new("pages");
    let path = database(&folder, "shop.db", SHOP);
    let client = driver();
    let server = client.connect(&params("pages", &path)).await.unwrap();
    assert!(server.server_version.starts_with('3'), "{server:?}");
    assert_eq!(server.database.as_deref(), Some("shop.db"));
    let first = run(&client, "pages", "SELECT n, label FROM numbers ORDER BY n")
        .await
        .unwrap();
    assert_eq!(first.rows.len(), 200);
    let (mut total, mut cursor, mut last) = (first.rows.len(), first.cursor, Value::Null);
    while let Some(open) = cursor {
        let page = client
            .fetch(&FetchParams {
                connection: "pages".into(),
                cursor: open,
                page_rows: Some(5000),
            })
            .await
            .unwrap();
        total += page.rows.len();
        last = page.rows.last().map_or(last, |row| row[0].clone());
        cursor = page.cursor;
    }
    assert_eq!((total, last), (100_000, Value::Integer(100_000)));
    // A result left open ends when the next request comes, and that request is answered.
    let open = run(&client, "pages", "SELECT n FROM numbers")
        .await
        .unwrap();
    assert!(open.cursor.is_some());
    assert_eq!(
        single(&client, "pages", "SELECT 7").await,
        Value::Integer(7)
    );
}

#[tokio::test]
async fn a_script_gives_each_result_and_a_write_its_count_and_rowid() {
    let folder = Folder::new("results");
    let path = database(&folder, "shop.db", SHOP);
    let client = driver();
    client.connect(&params("results", &path)).await.unwrap();
    let script =
        "CREATE TABLE t (a); INSERT INTO t VALUES (1), (2); SELECT a FROM t; SELECT 'two', 2";
    let both = run(&client, "results", script).await.unwrap();
    assert_eq!(both.rows, [[Value::Integer(1)], [Value::Integer(2)]]);
    assert_eq!(both.results.len(), 1);
    assert_eq!(
        both.results[0].rows,
        [[Value::Text("two".into()), Value::Integer(2)]]
    );
    // A write says how many rows it changed and the rowid it inserted; values are bound.
    let insert = statement(
        "results",
        "INSERT INTO customers (email) VALUES (?)",
        vec![Value::Text("eva@example.com".into())],
    );
    let inserted = client.execute(&insert).await.unwrap();
    assert_eq!(inserted.affected, Some(1));
    assert_eq!(inserted.notices[0].message, "Last inserted rowid: 3");
    let update = statement(
        "results",
        "UPDATE orders SET status = ? WHERE customer = ?",
        vec![Value::Text("sent".into()), Value::Integer(1)],
    );
    assert_eq!(client.execute(&update).await.unwrap().affected, Some(2));
    let wrong = statement("results", "SELECT ?", Vec::new());
    let refused = client.execute(&wrong).await.unwrap_err();
    assert_eq!(refused.code, ErrorCode::Invalid);
    assert!(
        refused.message.contains("takes 1 parameters"),
        "{refused:?}"
    );
    // A syntax error says where it is.
    let failed = run(&client, "results", "SELECT 1,\n  2 FORM t")
        .await
        .unwrap_err();
    assert_eq!(failed.code, ErrorCode::Syntax);
    let detail = failed.detail.unwrap();
    assert_eq!(
        (detail["line"].as_u64(), detail["column"].as_u64()),
        (Some(2), Some(10))
    );
    let missing = run(&client, "results", "SELECT * FROM nothing")
        .await
        .unwrap_err();
    assert_eq!(missing.code, ErrorCode::Syntax, "{missing:?}");
}

#[tokio::test]
async fn manual_commit_opens_a_transaction_that_waits_for_its_end() {
    let folder = Folder::new("manual");
    let path = database(&folder, "shop.db", SHOP);
    let client = driver();
    client.connect(&params("manual", &path)).await.unwrap();
    let action = |action| TransactionParams {
        connection: "manual".into(),
        action,
        isolation: None,
    };
    let state = client
        .transaction(&action(TransactionAction::Manual))
        .await
        .unwrap();
    assert!(!state.auto_commit && !state.open);
    run(&client, "manual", "DELETE FROM orders").await.unwrap();
    let state = client
        .transaction(&action(TransactionAction::Status))
        .await
        .unwrap();
    assert!(state.open, "the first statement opened a transaction");
    let state = client
        .transaction(&action(TransactionAction::Rollback))
        .await
        .unwrap();
    assert!(!state.open);
    assert_eq!(
        single(&client, "manual", "SELECT count(*) FROM orders").await,
        Value::Integer(3)
    );
    // Back to auto-commit, what is open is committed.
    run(&client, "manual", "DELETE FROM orders WHERE id = 3")
        .await
        .unwrap();
    let state = client
        .transaction(&action(TransactionAction::Auto))
        .await
        .unwrap();
    assert!(state.auto_commit && !state.open);
    let mut serial = action(TransactionAction::Begin);
    serial.isolation = Some("read committed".into());
    let refused = client.transaction(&serial).await.unwrap_err();
    assert_eq!(refused.code, ErrorCode::Unsupported);
    assert_eq!(
        single(&client, "manual", "SELECT count(*) FROM orders").await,
        Value::Integer(2)
    );
}
