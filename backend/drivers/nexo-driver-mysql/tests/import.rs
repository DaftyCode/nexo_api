//! Rows imported by the MySQL driver against MySQL 8.4 and MariaDB 11.4: a failed row said and undone
//! alone, a batch stopped at its first failure leaving nothing, and rows updated by key.
mod common;

use common::{driver, mariadb, params, run, single};
use nexo_driver_sdk::{
    Value,
    import::{ImportMode, ImportParams},
};

fn batch(rows: Vec<Vec<Value>>, mode: ImportMode, stop: bool) -> ImportParams {
    ImportParams {
        connection: "import".into(),
        schema: None,
        table: "imported".into(),
        columns: vec!["id".into(), "label".into()],
        rows,
        mode,
        key: vec!["id".into()],
        stop_on_error: stop,
        first: 1,
    }
}
fn row(id: i64, label: &str) -> Vec<Value> {
    vec![Value::Integer(id), Value::Text(label.into())]
}

#[tokio::test]
async fn mysql_imports_rows_says_its_failures_and_a_stop_leaves_nothing() {
    check(fixture!(params("import"))).await;
}

#[tokio::test]
async fn mariadb_imports_rows_says_its_failures_and_a_stop_leaves_nothing() {
    check(fixture!(mariadb("import"))).await;
}

async fn check(connect: nexo_driver_sdk::protocol::ConnectParams) {
    let client = driver();
    client.connect(&connect).await.unwrap();
    run(&client, "import", "DROP TABLE IF EXISTS imported")
        .await
        .unwrap();
    run(
        &client,
        "import",
        "CREATE TABLE imported (id int PRIMARY KEY, label varchar(5))",
    )
    .await
    .unwrap();
    let done = client
        .import(&batch(
            vec![row(1, "a"), row(2, "too long"), row(3, "c")],
            ImportMode::Insert,
            false,
        ))
        .await
        .unwrap();
    assert_eq!((done.inserted, done.failed), (2, 1));
    assert_eq!(done.failures[0].position, 2);
    assert!(done.failures[0].message.to_lowercase().contains("too long"));

    let stopped = client
        .import(&batch(
            vec![row(4, "d"), row(5, "e"), row(1, "dup")],
            ImportMode::Insert,
            true,
        ))
        .await
        .unwrap();
    assert!(stopped.stopped);
    let count = single(&client, "import", "SELECT count(*) FROM imported").await;
    assert_eq!(count, Value::Integer(2));

    let upserted = client
        .import(&batch(
            vec![row(1, "new"), row(9, "z")],
            ImportMode::Upsert,
            false,
        ))
        .await
        .unwrap();
    assert_eq!(upserted.upserted, 2);
    let label = single(&client, "import", "SELECT label FROM imported WHERE id = 1").await;
    assert_eq!(label, Value::Text("new".into()));
    run(&client, "import", "DROP TABLE imported").await.unwrap();
}
