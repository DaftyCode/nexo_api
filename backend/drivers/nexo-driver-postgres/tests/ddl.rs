//! The DDL of the tables recreates them as they were, in an empty database.
mod common;

use common::{driver, params, run};
use nexo_driver_sdk::{
    Value,
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
