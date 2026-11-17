//! Searching SQL Server against the fixture: objects by name and in the code of a function,
//! and a value in the data of tables, its wildcards taken literally.
mod common;

use common::{driver, params, run};
use nexo_driver_sdk::search::{SearchMode, SearchParams, SearchTable};

fn search(mode: SearchMode, text: &str) -> SearchParams {
    SearchParams {
        connection: "find".into(),
        statement: "search-1".into(),
        mode,
        text: text.into(),
        kinds: Vec::new(),
        code: true,
        schemas: vec!["dbo".into()],
        max: None,
        tables: Vec::new(),
        case_sensitive: false,
        whole_word: false,
        columns: Vec::new(),
        max_rows: None,
    }
}
fn table(name: &str) -> SearchTable {
    SearchTable {
        schema: Some("dbo".into()),
        name: name.into(),
        path: Vec::new(),
    }
}

#[tokio::test]
async fn objects_and_data_are_found() {
    let connect = fixture!(params("find"));
    let client = driver();
    client.connect(&connect).await.unwrap();
    for sql in [
        "DROP FUNCTION IF EXISTS dbo.search_total",
        "DROP TABLE IF EXISTS dbo.search_orders, dbo.search_notes",
        "CREATE TABLE dbo.search_orders (id int, order_note nvarchar(100))",
        "CREATE TABLE dbo.search_notes (id int, body nvarchar(100))",
        "INSERT INTO dbo.search_orders VALUES (1, 'gift 50%_off'), (2, 'plain')",
        "INSERT INTO dbo.search_notes VALUES (7, 'nothing here'), (8, 'GIFT 50%_off too')",
        "CREATE FUNCTION dbo.search_total() RETURNS bigint AS BEGIN RETURN (SELECT count(*) FROM dbo.search_orders) END",
    ] {
        run(&client, "find", sql).await.unwrap();
    }
    let found = client
        .search(&search(SearchMode::Metadata, "%search_order%"))
        .await
        .unwrap();
    let kinds: Vec<(&str, &str, bool)> = found
        .objects
        .iter()
        .map(|hit| (hit.kind.as_str(), hit.name.as_str(), hit.in_code))
        .collect();
    assert!(
        kinds.contains(&("table", "search_orders", false)),
        "{kinds:?}"
    );
    assert!(
        kinds.contains(&("function", "search_total", true)),
        "{kinds:?}"
    );
    let table_hit = found
        .objects
        .iter()
        .find(|hit| hit.kind == "table")
        .unwrap();
    assert_eq!(table_hit.path.last().unwrap(), "search_orders");
    let columns = client
        .search(&search(SearchMode::Metadata, "order_n*"))
        .await
        .unwrap();
    assert!(
        columns
            .objects
            .iter()
            .any(|hit| hit.kind == "column" && hit.name == "order_note")
    );

    let mut data = search(SearchMode::Data, "50%_off");
    data.tables = vec![table("search_orders"), table("search_notes")];
    let found = client.search(&data).await.unwrap();
    assert_eq!(found.data.len(), 2);
    assert_eq!(found.data[0].matched, ["order_note"]);
    assert_eq!(found.data[0].rows.len(), 1);
    data.text = "50%off".into();
    assert!(client.search(&data).await.unwrap().data.is_empty());
    data.text = "7".into();
    let numbers = client.search(&data).await.unwrap();
    assert_eq!(numbers.data[0].table, "search_notes");
    assert_eq!(numbers.data[0].matched, ["id"]);
    for sql in [
        "DROP FUNCTION dbo.search_total",
        "DROP TABLE dbo.search_orders, dbo.search_notes",
    ] {
        run(&client, "find", sql).await.unwrap();
    }
}
