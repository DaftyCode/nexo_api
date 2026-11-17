//! Searching SQLite: objects by name and in the code of a trigger, and a value in the data of
//! tables, its wildcards taken literally.
mod common;

use common::{Folder, database, driver, params};
use nexo_driver_sdk::search::{SearchMode, SearchParams, SearchTable};

fn search(mode: SearchMode, text: &str) -> SearchParams {
    SearchParams {
        connection: "find".into(),
        statement: "search-1".into(),
        mode,
        text: text.into(),
        kinds: Vec::new(),
        code: true,
        schemas: Vec::new(),
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

#[tokio::test]
async fn objects_and_data_are_found() {
    let folder = Folder::new("search");
    let path = database(
        &folder,
        "search.db",
        "CREATE TABLE search_orders (id INTEGER, order_note TEXT);
         CREATE TABLE search_notes (id INTEGER, body TEXT);
         INSERT INTO search_orders VALUES (1, 'gift 50%_off'), (2, 'plain');
         INSERT INTO search_notes VALUES (7, 'nothing here'), (8, 'GIFT 50%_off too');
         CREATE TRIGGER search_total AFTER INSERT ON search_notes BEGIN
           UPDATE search_orders SET id = id WHERE id = 0;
         END;",
    );
    let client = driver();
    client.connect(&params("find", &path)).await.unwrap();
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
}
