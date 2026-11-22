//! The Drill module against the fixture's embedded Drillbit (`tools/nosql-fixture.sh`): the
//! conformance checks that apply, the tree down to a file's columns, a Parquet file read with
//! its types, pages that run the statement again, a long statement cancelled, a plugin shown
//! without its password, and an address the egress policy refuses.
mod common;

use common::{Host, driver, driver_with, params};
use nexo_driver_drill::DrillDriver;
use nexo_driver_sdk::{
    Value, ValueKind,
    conformance::{Suite, check},
    protocol::ObjectParams,
    statements::{CancelParams, ExecuteParams, FetchParams},
};

const NATION: &str = "SELECT N_NATIONKEY, N_NAME FROM dfs.`/opt/drill/sample-data/nation.parquet` ORDER BY N_NATIONKEY";

#[tokio::test]
async fn drill_passes_the_conformance_checks() {
    let connect = fixture!(params("conformance"));
    let suite = Suite {
        connect,
        wrong_password: None,
        paged_sql: "SELECT * FROM cp.`employee.json`".into(),
        paged_rows: 1155,
        slow_sql: None,
        invalid_sql: "SELECT FROM".into(),
        values: vec![
            (
                "SELECT 'O''Brien' AS t FROM (VALUES(1))".into(),
                Value::Text("O'Brien".into()),
            ),
            (
                "SELECT CAST(NULL AS VARCHAR) AS t FROM (VALUES(1))".into(),
                Value::Null,
            ),
        ],
        rollback: None,
    };
    let failures = check(DrillDriver::default(), suite).await;
    assert!(failures.is_empty(), "{failures:#?}");
}

#[tokio::test]
async fn a_parquet_file_is_read_with_its_types_by_pages() {
    let connect = fixture!(params("files"));
    let client = driver();
    client.connect(&connect).await.unwrap();
    let execute = |sql: &str, rows| ExecuteParams {
        connection: "files".into(),
        statement: "s".into(),
        sql: sql.into(),
        params: Vec::new(),
        page_rows: Some(rows),
        max_rows: None,
    };
    let first = client.execute(&execute(NATION, 10)).await.unwrap();
    assert_eq!(first.columns[0].kind, ValueKind::Integer);
    assert_eq!(
        first.rows[0],
        [Value::Integer(0), Value::Text("ALGERIA".into())]
    );
    assert!(first.notices[0].message.contains("again for each page"));
    let mut total = first.rows.len();
    let mut cursor = first.cursor;
    while let Some(open) = cursor {
        let page = client
            .fetch(&FetchParams {
                connection: "files".into(),
                cursor: open,
                page_rows: Some(10),
            })
            .await
            .unwrap();
        total += page.rows.len();
        cursor = page.cursor;
    }
    assert_eq!(total, 25);
}

#[tokio::test]
async fn the_tree_goes_down_to_columns_and_a_plugin_hides_its_password() {
    let connect = fixture!(params("tree"));
    let client = driver();
    client.connect(&connect).await.unwrap();
    let tree = |path: &[&str]| {
        let client = client.clone();
        let path = path.iter().map(|part| (*part).to_owned()).collect();
        async move {
            client
                .tree(&ObjectParams {
                    connection: "tree".into(),
                    path,
                })
                .await
                .unwrap()
        }
    };
    let plugins = tree(&[]).await;
    assert!(plugins.iter().any(|node| node.name == "dfs"));
    assert!(
        !plugins.iter().any(|node| node.name == "secretmongo"),
        "a disabled plugin is not listed"
    );
    let schemas = tree(&["cp"]).await;
    assert!(schemas.iter().any(|node| node.name == "cp.default"));
    let sheet = client
        .describe(&ObjectParams {
            connection: "tree".into(),
            path: vec!["secretmongo".into()],
        })
        .await
        .unwrap();
    let shown = format!("{sheet:?}");
    assert!(!shown.contains("s3cret-pass"), "{shown}");
    assert!(shown.contains("[redacted]"));
}

#[tokio::test]
async fn a_long_statement_is_cancelled() {
    let connect = fixture!(params("slow"));
    let client = driver();
    client.connect(&connect).await.unwrap();
    let slow =
        "SELECT COUNT(*) FROM cp.`employee.json` a, cp.`employee.json` b, cp.`employee.json` c";
    let running = {
        let client = client.clone();
        tokio::spawn(async move {
            client
                .execute(&ExecuteParams {
                    connection: "slow".into(),
                    statement: "long".into(),
                    sql: slow.into(),
                    params: Vec::new(),
                    page_rows: None,
                    max_rows: None,
                })
                .await
        })
    };
    tokio::time::sleep(std::time::Duration::from_secs(2)).await;
    client
        .cancel(&CancelParams {
            connection: "slow".into(),
            statement: "long".into(),
        })
        .await
        .unwrap();
    let outcome = running.await.unwrap();
    assert!(outcome.is_err(), "{outcome:?}");
}

#[tokio::test]
async fn an_address_the_policy_refuses_is_never_connected() {
    let connect = fixture!(params("refused"));
    let host = Host::default();
    host.refused
        .lock()
        .unwrap()
        .push(connect.host.clone().unwrap());
    let error = driver_with(host).connect(&connect).await.unwrap_err();
    assert!(error.message.contains("egress policy"), "{error}");
}
