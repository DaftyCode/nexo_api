//! DuckDB databases (DB-30): a `.duckdb` file with its schemas, tables and views; written
//! unless the connection only reads; and the SDK's conformance checks on it.
mod common;

use common::{Folder, driver, duckdb, params, run, single};
use nexo_driver_files::FilesDriver;
use nexo_driver_sdk::{
    ErrorCode, Value,
    conformance::{Suite, check},
    protocol::{ConnectParams, ObjectParams, TreeNode},
};

fn shop(folder: &Folder) -> String {
    let path = folder
        .file("shop.duckdb")
        .display()
        .to_string()
        .replace('\\', "/");
    duckdb(&format!(
        "ATTACH '{path}' AS shop; USE shop;
         CREATE TABLE customers (id INTEGER PRIMARY KEY, email VARCHAR);
         INSERT INTO customers VALUES (1, 'ana@example.com'), (2, 'luis@example.com');
         CREATE VIEW emails AS SELECT email FROM customers;
         CREATE TABLE numbers AS SELECT range AS n, 'n' || range AS label FROM range(1, 121);"
    ));
    path
}

#[tokio::test]
async fn a_duckdb_database_shows_its_schemas_tables_and_views() {
    let folder = Folder::new("database");
    let path = shop(&folder);
    let client = driver();
    client.connect(&params("d1", &path, &[])).await.unwrap();
    async fn tree(client: &nexo_driver_sdk::Client, path: &[&str]) -> Vec<TreeNode> {
        let params = ObjectParams {
            connection: "d1".into(),
            path: path.iter().map(|part| (*part).to_owned()).collect(),
        };
        client.tree(&params).await.unwrap()
    }
    let schemas = tree(&client, &[]).await;
    assert!(
        schemas
            .iter()
            .any(|node| node.name == "main" && node.kind == "schema")
    );
    let tables = tree(&client, &["main", "tables"]).await;
    assert_eq!(
        tables.iter().map(|n| n.name.as_str()).collect::<Vec<_>>(),
        ["customers", "numbers"]
    );
    let views = tree(&client, &["main", "views"]).await;
    assert_eq!(views[0].name, "emails");
    let columns = tree(&client, &["main", "tables", "customers"]).await;
    assert_eq!(columns.len(), 2);
    run(
        &client,
        "d1",
        "INSERT INTO customers VALUES (3, 'eva@example.com')",
    )
    .await
    .unwrap();
    assert_eq!(
        single(&client, "d1", "SELECT count(*) FROM emails").await,
        Value::Integer(3)
    );
    client.disconnect("d1").await.unwrap();

    let mut read_only = params("d2", &path, &[]);
    read_only.read_only = true;
    client.connect(&read_only).await.unwrap();
    let refused = run(&client, "d2", "DELETE FROM customers")
        .await
        .unwrap_err();
    assert_ne!(refused.code, ErrorCode::Internal, "{refused:?}");
    assert_eq!(
        single(&client, "d2", "SELECT count(*) FROM customers").await,
        Value::Integer(3)
    );
}

#[tokio::test]
async fn a_duckdb_database_passes_the_conformance_checks() {
    let folder = Folder::new("conformance");
    let path = shop(&folder);
    let suite = Suite {
        connect: ConnectParams {
            database: Some(path),
            ..params("conformance", "", &[])
        },
        wrong_password: None,
        paged_sql: "SELECT n, label FROM numbers ORDER BY n".into(),
        paged_rows: 120,
        slow_sql: Some("SELECT count(*) FROM range(10000000000) a".into()),
        invalid_sql: "SELECT 1 +".into(),
        values: vec![
            (
                "SELECT 9007199254740993".into(),
                Value::typed(nexo_driver_sdk::ValueKind::Decimal, "9007199254740993"),
            ),
            ("SELECT 1.5::DOUBLE".into(), Value::Float(1.5)),
            ("SELECT '\\x00\\xFF'::BLOB".into(), Value::bytes(&[0, 255])),
            ("SELECT NULL".into(), Value::Null),
            ("SELECT 'año'".into(), Value::Text("año".into())),
        ],
        // No transactions: each statement is its own.
        rollback: None,
    };
    let failures = check(FilesDriver::default(), suite).await;
    assert!(failures.is_empty(), "{failures:#?}");
}
