//! Data into a table: batches of a file, the `CREATE TABLE` of another engine, and pages of
//! a query copied from one session to another.
use super::*;

#[tokio::test]
async fn a_batch_is_written_by_the_target_driver_with_its_rules() {
    let (application, _, sources) = with_sources(json!({}));
    connect(&application, "s1").await.unwrap();
    let done = application
        .execute(
            Operation::DbImport,
            json!({"session": "s1", "table": "items", "columns": ["id", "label"],
                   "rows": [[1, "a"], [2, "b"]], "mode": "upsert", "key": ["id"], "first": 1001}),
        )
        .await
        .unwrap();
    assert_eq!(done["inserted"], 2);
    let (session, request) = sources.imported.lock().unwrap()[0].clone();
    assert_eq!(session, "s1");
    assert_eq!(request["mode"], "upsert");
    assert_eq!(request["first"], 1001);
    assert_eq!(request["stopOnError"], false);

    let (application, _, _) = with_sources(json!({"readOnly": true}));
    connect(&application, "s1").await.unwrap();
    let refused = application
        .execute(
            Operation::DbImport,
            json!({"session": "s1", "table": "t", "columns": ["a"], "rows": [[1]], "confirm": true}),
        )
        .await;
    assert!(message(refused).contains("read-only"));

    let (application, _, _) = with_sources(json!({"type": "production"}));
    connect(&application, "s1").await.unwrap();
    let unconfirmed = application
        .execute(
            Operation::DbImport,
            json!({"session": "s1", "table": "t", "columns": ["a"], "rows": [[1]]}),
        )
        .await;
    assert!(message(unconfirmed).contains("for production"));
}

#[tokio::test]
async fn columns_get_the_create_table_of_the_session_engine() {
    let (application, _, _) = with_sources(json!({}));
    connect(&application, "s1").await.unwrap();
    let converted = application
        .execute(
            Operation::DbConvert,
            json!({"session": "s1", "table": "copied", "sourceDriver": "postgres",
                   "columns": [{"name": "id", "kind": "integer", "typeName": "int8", "nullable": false},
                               {"name": "tags", "kind": "array", "typeName": "_text"}]}),
        )
        .await
        .unwrap();
    // The fake's connection is PostgreSQL: the same engine keeps the types.
    assert_eq!(
        converted["sql"],
        "CREATE TABLE \"copied\" (\n  \"id\" int8 NOT NULL,\n  \"tags\" _text\n)"
    );
    assert_eq!(converted["columns"][1]["asText"], false);
    let unnamed = application
        .execute(
            Operation::DbConvert,
            json!({"session": "s1", "table": "t", "columns": [{"name": " ", "kind": "text"}]}),
        )
        .await;
    assert!(message(unnamed).contains("needs a name"));
}

#[tokio::test]
async fn a_query_is_copied_page_by_page_from_driver_to_driver() {
    let (application, _, sources) = with_sources(json!({}));
    connect(&application, "s1").await.unwrap();
    connect(&application, "s2").await.unwrap();
    let first = application
        .execute(
            Operation::DbCopy,
            json!({"source": "s1", "target": "s2", "table": "copy", "sql": "SELECT n FROM t"}),
        )
        .await
        .unwrap();
    assert_eq!(first["read"], 2);
    assert_eq!(first["inserted"], 2);
    assert_eq!(first["columns"][0]["name"], "n");
    let (session, request) = sources.imported.lock().unwrap()[0].clone();
    assert_eq!(session, "s2");
    assert_eq!(request["columns"], json!(["n"]));
    assert_eq!(request["rows"], json!([[1], [2]]));
    let next = application
        .execute(
            Operation::DbCopy,
            json!({"source": "s1", "target": "s2", "table": "copy", "cursor": "k1", "columns": ["n"], "first": 3}),
        )
        .await
        .unwrap();
    assert_eq!(next["read"], 1);
    assert_eq!(sources.imported.lock().unwrap()[1].1["first"], 3);
    let writes = application
        .execute(
            Operation::DbCopy,
            json!({"source": "s1", "target": "s2", "table": "copy", "sql": "DELETE FROM t"}),
        )
        .await;
    assert!(message(writes).contains("Only what a query reads"));
}

#[tokio::test]
async fn columns_can_be_written_for_another_engine() {
    let (application, _, _) = with_sources(json!({}));
    connect(&application, "s1").await.unwrap();
    let converted = application
        .execute(
            Operation::DbConvert,
            json!({"session": "s1", "table": "t", "sourceDriver": "postgres", "targetDriver": "mysql",
                   "columns": [{"name": "id", "kind": "uuid", "typeName": "uuid"}]}),
        )
        .await
        .unwrap();
    assert_eq!(converted["sql"], "CREATE TABLE `t` (\n  `id` CHAR(36)\n)");
    assert_eq!(converted["columns"][0]["asText"], true);
}
