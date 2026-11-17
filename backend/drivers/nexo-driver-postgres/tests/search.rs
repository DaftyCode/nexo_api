//! Searching PostgreSQL against the fixture: objects by name and in the code of a function,
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
        schemas: vec!["public".into()],
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
        schema: Some("public".into()),
        name: name.into(),
        path: Vec::new(),
    }
}

#[tokio::test]
async fn objects_and_data_are_found() {
    let connect = fixture!(params("find", None));
    let client = driver();
    client.connect(&connect).await.unwrap();
    for sql in [
        "DROP TABLE IF EXISTS public.search_orders, public.search_notes",
        "DROP FUNCTION IF EXISTS public.search_total()",
        "CREATE TABLE public.search_orders (id int, order_note text)",
        "CREATE TABLE public.search_notes (id int, body text)",
        "INSERT INTO public.search_orders VALUES (1, 'gift 50%_off'), (2, 'plain')",
        "INSERT INTO public.search_notes VALUES (7, 'nothing here'), (8, 'GIFT 50%_off too')",
        "CREATE FUNCTION public.search_total() RETURNS bigint LANGUAGE sql AS 'SELECT count(*) FROM public.search_orders'",
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
    assert!(kinds.contains(&("table", "search_orders", false)));
    // The function's code names the table.
    assert!(kinds.contains(&("function", "search_total", true)));
    let table_hit = found
        .objects
        .iter()
        .find(|hit| hit.kind == "table")
        .unwrap();
    assert_eq!(
        table_hit.path[1..],
        ["schemas", "public", "tables", "search_orders"]
    );
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
    // `%` and `_` are literal: `50 off` is not found.
    data.text = "50%off".into();
    assert!(client.search(&data).await.unwrap().data.is_empty());
    data.text = "7".into();
    let numbers = client.search(&data).await.unwrap();
    assert_eq!(numbers.data[0].table, "search_notes");
    assert_eq!(numbers.data[0].matched, ["id"]);
    for sql in [
        "DROP FUNCTION public.search_total()",
        "DROP TABLE public.search_orders, public.search_notes",
    ] {
        run(&client, "find", sql).await.unwrap();
    }
}
