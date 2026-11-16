//! The tree shows what the fixture has, objects describe themselves, and the DDL of the
//! tables recreates them as they were in an empty database.
mod common;

use common::{driver, params, run};
use nexo_driver_sdk::{
    Client, Value,
    protocol::{ObjectDescription, ObjectParams, Section, TreeNode},
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

async fn nodes(client: &Client, connection: &str, segments: &[&str]) -> Vec<TreeNode> {
    client.tree(&path(connection, segments)).await.unwrap()
}

async fn names(client: &Client, connection: &str, segments: &[&str]) -> Vec<String> {
    nodes(client, connection, segments)
        .await
        .into_iter()
        .map(|node| node.label)
        .collect()
}

fn system(nodes: Vec<TreeNode>) -> Vec<String> {
    nodes
        .into_iter()
        .filter(|node| node.system)
        .map(|node| node.name)
        .collect()
}

fn section<'a>(description: &'a ObjectDescription, id: &str) -> &'a Section {
    description
        .sections
        .iter()
        .find(|section| section.id == id)
        .unwrap()
}

fn cell(section: &Section, column: &str) -> Value {
    let at = section
        .columns
        .iter()
        .position(|name| name == column)
        .unwrap();
    section.rows[0][at].clone()
}

#[tokio::test]
async fn the_tree_shows_what_the_server_has() {
    let connect = fixture!(params("tree"));
    let client = driver();
    client.connect(&connect).await.unwrap();
    let name = "tree";
    assert_eq!(
        names(&client, name, &[]).await,
        ["Databases", "Security", "Administration"]
    );
    assert_eq!(
        system(nodes(&client, name, &[]).await),
        ["security", "administration"]
    );
    let databases = nodes(&client, name, &["databases"]).await;
    // The user's databases first (another test may be making one), then the system ones.
    let users: Vec<&str> = databases
        .iter()
        .take_while(|node| !node.system)
        .map(|node| node.name.as_str())
        .collect();
    assert!(users.contains(&"shop"), "{databases:?}");
    assert_eq!(system(databases), ["master", "model", "msdb", "tempdb"]);
    let schemas = nodes(&client, name, &["databases", "shop", "schemas"]).await;
    let listed: Vec<&str> = schemas.iter().map(|node| node.name.as_str()).collect();
    assert!(
        listed.contains(&"shop") && listed.contains(&"dbo"),
        "{listed:?}"
    );
    assert_eq!(system(schemas), ["guest", "INFORMATION_SCHEMA", "sys"]);
    let shop = |folder: &'static str| ["databases", "shop", "schemas", "shop", folder];
    assert_eq!(
        names(&client, name, &shop("tables")).await,
        ["customers", "orders"]
    );
    assert_eq!(names(&client, name, &shop("views")).await, ["open_orders"]);
    assert_eq!(
        names(&client, name, &shop("procedures")).await,
        ["two_results"]
    );
    assert_eq!(
        names(&client, name, &shop("functions")).await,
        ["order_count"]
    );
    assert_eq!(
        names(&client, name, &shop("sequences")).await,
        ["invoice_numbers"]
    );
    assert_eq!(names(&client, name, &shop("synonyms")).await, ["buyers"]);
    assert_eq!(names(&client, name, &shop("types")).await, ["positive"]);
    assert_eq!(
        names(&client, name, &shop("triggers")).await,
        ["orders_touch"]
    );
    assert!(
        names(&client, name, &shop("indexes"))
            .await
            .contains(&"IX_orders_status".to_owned())
    );
    let orders = ["databases", "shop", "schemas", "shop", "tables", "orders"];
    let part = |part: &'static str| [&orders[..], &[part]].concat();
    assert_eq!(
        names(&client, name, &part("columns")).await,
        ["id", "customer", "status", "total", "twice"]
    );
    assert_eq!(
        names(&client, name, &part("constraints")).await,
        ["CK_orders_total", "PK_orders"]
    );
    assert_eq!(
        names(&client, name, &part("foreign-keys")).await,
        ["FK_orders_customer"]
    );
    assert_eq!(
        names(&client, name, &part("triggers")).await,
        ["orders_touch"]
    );
    // What a table lists only to be seen: what uses it and the keys that point to it.
    assert_eq!(
        names(&client, name, &part("dependencies")).await,
        ["open_orders", "order_count", "two_results"]
    );
    let customers = [
        "databases",
        "shop",
        "schemas",
        "shop",
        "tables",
        "customers",
    ];
    let of = |part: &'static str| [&customers[..], &[part]].concat();
    assert_eq!(
        names(&client, name, &of("references")).await,
        ["shop.orders"]
    );
    assert!(names(&client, name, &part("policies")).await.is_empty());
    assert!(
        names(&client, name, &["security", "logins"])
            .await
            .contains(&"sa".to_owned())
    );

    // An object describes itself, with both ends of its keys by column.
    let described = client.describe(&path(name, &orders)).await.unwrap();
    assert_eq!(section(&described, "columns").rows.len(), 5);
    let keys = section(&described, "foreign-keys");
    assert_eq!(cell(keys, "Columns"), Value::Text("customer".into()));
    assert_eq!(cell(keys, "Referenced schema"), Value::Text("shop".into()));
    assert_eq!(
        cell(keys, "Referenced table"),
        Value::Text("customers".into())
    );
    assert_eq!(cell(keys, "Referenced columns"), Value::Text("id".into()));
    let customers = client
        .describe(&path(name, &[&shop("tables")[..], &["customers"]].concat()))
        .await
        .unwrap();
    let by = section(&customers, "references");
    assert_eq!(cell(by, "Table name"), Value::Text("orders".into()));
    assert_eq!(cell(by, "Columns"), Value::Text("customer".into()));
    assert!(
        customers
            .properties
            .iter()
            .any(|property| property.value == Value::Text("People who buy".into())),
        "{:?}",
        customers.properties
    );
    let index = section(&described, "indexes");
    let filtered = index
        .rows
        .iter()
        .find(|row| row[0] == Value::Text("IX_orders_status".into()))
        .unwrap();
    assert!(
        filtered.contains(&Value::Text("[total]".into())),
        "{filtered:?}"
    );
    let function = client
        .describe(&path(
            name,
            &[&shop("functions")[..], &["order_count"]].concat(),
        ))
        .await
        .unwrap();
    let definition = function
        .properties
        .iter()
        .find(|property| property.name == "Definition")
        .unwrap();
    assert!(
        matches!(&definition.value, Value::Text(text) if text.contains("COUNT(*)")),
        "{definition:?}"
    );
    // Another database is read through its own catalog, on the same connection.
    let master = names(&client, name, &["databases", "master", "schemas"]).await;
    assert!(master.contains(&"dbo".to_owned()));
}

/// The columns, constraints, keys and indexes of a table, as `describe` lists them.
fn shape(description: &ObjectDescription) -> Vec<Vec<Vec<Value>>> {
    ["columns", "constraints", "foreign-keys", "indexes"]
        .iter()
        .map(|id| section(description, id).rows.clone())
        .collect()
}

const DROP_COPY: &str = "IF DB_ID('ddl_copy') IS NOT NULL BEGIN \
    ALTER DATABASE ddl_copy SET SINGLE_USER WITH ROLLBACK IMMEDIATE; DROP DATABASE ddl_copy; END";

#[tokio::test]
async fn the_ddl_of_a_table_recreates_it() {
    let connect = fixture!(params("ddl"));
    let client = driver();
    client.connect(&connect).await.unwrap();
    run(&client, "ddl", DROP_COPY).await.unwrap();
    run(&client, "ddl", "CREATE DATABASE ddl_copy")
        .await
        .unwrap();
    let mut copy = connect.clone();
    copy.connection = "ddl-copy".into();
    copy.database = Some("ddl_copy".into());
    client.connect(&copy).await.unwrap();
    let object = |segments: &[&str]| path("ddl", &[&["databases", "shop"], segments].concat());
    let mut scripts = vec![client.ddl(&object(&["schemas", "shop"])).await.unwrap().sql];
    for name in ["customers", "orders"] {
        scripts.push(
            client
                .ddl(&object(&["schemas", "shop", "tables", name]))
                .await
                .unwrap()
                .sql,
        );
    }
    for script in &scripts {
        for statement in script
            .split(";\n")
            .map(str::trim)
            .filter(|text| !text.is_empty())
        {
            let statement = statement.trim_end_matches(';');
            run(&client, "ddl-copy", statement)
                .await
                .unwrap_or_else(|error| panic!("{statement}: {error:?}"));
        }
    }
    for name in ["customers", "orders"] {
        let table = |db: &str| path("ddl", &["databases", db, "schemas", "shop", "tables", name]);
        let original = client.describe(&table("shop")).await.unwrap();
        let recreated = client.describe(&table("ddl_copy")).await.unwrap();
        assert_eq!(shape(&original), shape(&recreated), "{name}");
    }
    let orders = &scripts[2];
    assert!(orders.contains("WHERE ([status]<>N'sent')"), "{orders}");
    assert!(
        scripts[1].contains("@value = N'Where receipts go'"),
        "{}",
        scripts[1]
    );
    // A view's DDL is its code.
    let view = client
        .ddl(&object(&["schemas", "shop", "views", "open_orders"]))
        .await
        .unwrap()
        .sql;
    assert!(view.starts_with("CREATE VIEW shop.open_orders"), "{view}");
    client.disconnect("ddl-copy").await.unwrap();
    run(&client, "ddl", DROP_COPY).await.unwrap();
}
