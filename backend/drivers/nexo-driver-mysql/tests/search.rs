//! Searching MySQL and MariaDB against the fixture: objects by name and in the code of a
//! function, and a value in the data of tables, its wildcards taken literally.
mod common;

use common::{driver, mariadb, params, run};
use nexo_driver_sdk::protocol::ConnectParams;
use nexo_driver_sdk::search::{SearchMode, SearchParams, SearchTable};

fn search(mode: SearchMode, text: &str) -> SearchParams {
    SearchParams {
        connection: "find".into(),
        statement: "search-1".into(),
        mode,
        text: text.into(),
        kinds: Vec::new(),
        code: true,
        schemas: vec!["shop".into()],
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
        schema: None,
        name: name.into(),
        path: Vec::new(),
    }
}

async fn check(connect: ConnectParams) {
    let client = driver();
    client.connect(&connect).await.unwrap();
    for sql in [
        "DROP TABLE IF EXISTS search_orders, search_notes",
        "DROP FUNCTION IF EXISTS search_total",
        "CREATE TABLE search_orders (id int, order_note text)",
        "CREATE TABLE search_notes (id int, body text)",
        "INSERT INTO search_orders VALUES (1, 'gift 50%_off'), (2, 'plain')",
        "INSERT INTO search_notes VALUES (7, 'nothing here'), (8, 'GIFT 50%_off too')",
        "CREATE FUNCTION search_total() RETURNS bigint READS SQL DATA RETURN (SELECT count(*) FROM search_orders)",
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
        "DROP FUNCTION search_total",
        "DROP TABLE search_orders, search_notes",
    ] {
        run(&client, "find", sql).await.unwrap();
    }
}

#[tokio::test]
async fn mysql_finds_objects_and_data() {
    check(fixture!(params("find"))).await;
}

#[tokio::test]
async fn mariadb_finds_objects_and_data() {
    check(fixture!(mariadb("find"))).await;
}
