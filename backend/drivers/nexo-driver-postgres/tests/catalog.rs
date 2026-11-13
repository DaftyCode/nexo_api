//! The tree shows what the fixture has, objects describe themselves, and the DDL of the
//! tables recreates them as they were in an empty database.
mod common;

use common::{driver, params, run};
use nexo_driver_sdk::{
    Client, Value,
    protocol::{ObjectDescription, ObjectParams},
};

fn path(connection: &str, segments: &[&str]) -> ObjectParams {
    ObjectParams {
        connection: connection.into(),
        path: segments
            .iter()
            .map(|segment| (*segment).to_owned())
            .collect(),
    }
}

async fn names(client: &Client, connection: &str, segments: &[&str]) -> Vec<String> {
    let nodes = client.tree(&path(connection, segments)).await.unwrap();
    nodes.into_iter().map(|node| node.label).collect()
}

async fn catalog(port: Option<&str>, name: &str) {
    let connect = fixture!(params(name, port));
    let client = driver();
    client.connect(&connect).await.unwrap();
    let top = names(&client, name, &[]).await;
    assert_eq!(top[0], "shop", "{top:?}");
    assert_eq!(
        names(&client, name, &["shop"]).await,
        ["Schemas", "Extensions", "Roles", "Tablespaces"]
    );
    let schemas = names(&client, name, &["shop", "schemas"]).await;
    assert!(
        schemas.contains(&"shop".to_owned()) && schemas.contains(&"public".to_owned()),
        "{schemas:?}"
    );
    let shop = |folder: &'static str| ["shop", "schemas", "shop", folder];
    assert_eq!(
        names(&client, name, &shop("tables")).await,
        ["customers", "events", "orders"]
    );
    assert_eq!(names(&client, name, &shop("views")).await, ["open_orders"]);
    assert_eq!(
        names(&client, name, &shop("materialized-views")).await,
        ["totals"]
    );
    assert_eq!(
        names(&client, name, &shop("sequences")).await,
        ["invoice_numbers"]
    );
    assert_eq!(
        names(&client, name, &shop("functions")).await,
        ["order_count(customer_id integer)", "touch()"]
    );
    assert_eq!(
        names(&client, name, &shop("procedures")).await,
        ["mark_sent(IN order_id bigint)"]
    );
    assert_eq!(
        names(&client, name, &shop("types")).await,
        ["address", "positive", "status"]
    );
    assert!(
        names(&client, name, &shop("indexes"))
            .await
            .contains(&"orders_status".to_owned())
    );
    assert!(
        names(&client, name, &["shop", "extensions"])
            .await
            .contains(&"hstore".to_owned())
    );
    let orders = ["shop", "schemas", "shop", "tables", "orders"];
    let part = |part: &'static str| [&orders[..], &[part]].concat();
    assert_eq!(
        names(&client, name, &part("columns")).await,
        ["id", "customer", "status", "total"]
    );
    assert_eq!(
        names(&client, name, &part("constraints")).await,
        ["orders_pkey", "orders_total_small"]
    );
    assert_eq!(
        names(&client, name, &part("foreign-keys")).await,
        ["orders_customer_fkey"]
    );
    assert_eq!(
        names(&client, name, &part("triggers")).await,
        ["orders_touch"]
    );
    let events = ["shop", "schemas", "shop", "tables", "events", "partitions"];
    assert_eq!(names(&client, name, &events).await, ["events_2026"]);

    // An object describes itself; a function shows its body.
    let described = client.describe(&path(name, &orders)).await.unwrap();
    let columns = described
        .sections
        .iter()
        .find(|section| section.id == "columns")
        .unwrap();
    assert_eq!(columns.rows.len(), 4);
    let referenced = client
        .describe(&path(
            name,
            &["shop", "schemas", "shop", "tables", "customers"],
        ))
        .await
        .unwrap();
    let by = referenced
        .sections
        .iter()
        .find(|section| section.id == "references")
        .unwrap();
    assert_eq!(by.rows.len(), 1);
    let functions = client.tree(&path(name, &shop("functions"))).await.unwrap();
    let count = functions
        .iter()
        .find(|node| node.label.starts_with("order_count"))
        .unwrap();
    let function = client
        .describe(&path(
            name,
            &["shop", "schemas", "shop", "functions", &count.name],
        ))
        .await
        .unwrap();
    let definition = function
        .properties
        .iter()
        .find(|property| property.name == "Definition")
        .unwrap();
    assert!(matches!(&definition.value, Value::Text(text) if text.contains("SELECT count(*)")));
    let column = client
        .describe(&path(name, &[&orders[..], &["columns", "total"]].concat()))
        .await
        .unwrap();
    assert!(
        column
            .properties
            .iter()
            .any(|property| property.value == Value::Text("shop.positive".into()))
    );
    // Another database of the server opens its own connection.
    let other = names(&client, name, &["postgres", "schemas"]).await;
    assert!(other.contains(&"public".to_owned()));
}

#[tokio::test]
async fn the_tree_shows_what_the_server_has() {
    catalog(None, "tree").await;
}

#[tokio::test]
async fn the_oldest_supported_server_has_the_same_tree() {
    catalog(Some("NEXO_SQL_PG_OLD_PORT"), "tree-old").await;
}

/// The columns, constraints and indexes of a table, as `describe` lists them, without their
/// sizes (the original has data).
fn shape(description: &ObjectDescription) -> Vec<Vec<Vec<Value>>> {
    ["columns", "constraints", "foreign-keys", "indexes"]
        .iter()
        .map(|id| {
            let section = description
                .sections
                .iter()
                .find(|section| section.id == *id)
                .unwrap();
            let size = section.columns.iter().position(|column| column == "Size");
            section
                .rows
                .iter()
                .map(|row| {
                    row.iter()
                        .enumerate()
                        .filter(|(index, _)| Some(*index) != size)
                        .map(|(_, value)| value.clone())
                        .collect()
                })
                .collect()
        })
        .collect()
}

#[tokio::test]
async fn the_ddl_of_a_table_recreates_it() {
    let connect = fixture!(params("ddl", None));
    let client = driver();
    client.connect(&connect).await.unwrap();
    let _ = run(&client, "ddl", "DROP DATABASE IF EXISTS ddl_copy").await;
    run(&client, "ddl", "CREATE DATABASE ddl_copy")
        .await
        .unwrap();
    let mut copy = connect.clone();
    copy.connection = "ddl-copy".into();
    copy.database = Some("ddl_copy".into());
    client.connect(&copy).await.unwrap();
    let object = |segments: &[&str]| path("ddl", &[&["shop"], segments].concat());
    let schema = client.ddl(&object(&["schemas", "shop"])).await.unwrap().sql;
    let mut scripts = vec![schema];
    for (folder, name) in [
        ("types", "status"),
        ("types", "positive"),
        ("tables", "customers"),
        ("tables", "orders"),
    ] {
        scripts.push(
            client
                .ddl(&object(&["schemas", "shop", folder, name]))
                .await
                .unwrap()
                .sql,
        );
    }
    run(&client, "ddl-copy", "CREATE FUNCTION public.touch_stub() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$").await.unwrap();
    let function = client
        .tree(&object(&["schemas", "shop", "functions"]))
        .await
        .unwrap();
    let touch = function
        .iter()
        .find(|node| node.label == "touch()")
        .unwrap();
    scripts.insert(
        3,
        client
            .ddl(&object(&["schemas", "shop", "functions", &touch.name]))
            .await
            .unwrap()
            .sql,
    );
    for script in &scripts {
        for statement in script
            .split(";\n")
            .map(str::trim)
            .filter(|text| !text.is_empty())
        {
            let statement = statement.trim_end_matches(';');
            // The trigger of orders calls shop.touch(), which the copy has too.
            run(&client, "ddl-copy", statement)
                .await
                .unwrap_or_else(|error| panic!("{statement}: {error:?}"));
        }
    }
    let table =
        |connection: &str, name: &str| path(connection, &["schemas", "shop", "tables", name]);
    for name in ["customers", "orders"] {
        let mut original = table("ddl", name);
        original.path.insert(0, "shop".into());
        let mut recreated = table("ddl-copy", name);
        recreated.path.insert(0, "ddl_copy".into());
        let (original, recreated) = (
            client.describe(&original).await.unwrap(),
            client.describe(&recreated).await.unwrap(),
        );
        assert_eq!(shape(&original), shape(&recreated), "{name}");
    }
    let customers = scripts
        .iter()
        .find(|script| script.contains("CREATE TABLE shop.customers"))
        .unwrap();
    assert!(
        customers.contains("COMMENT ON COLUMN shop.customers.email IS 'Where receipts go'"),
        "{customers}"
    );
    client.disconnect("ddl-copy").await.unwrap();
    run(&client, "ddl", "DROP DATABASE ddl_copy").await.unwrap();
}
