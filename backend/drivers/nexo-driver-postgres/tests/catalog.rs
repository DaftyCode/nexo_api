//! The tree shows what the fixture has, and objects describe themselves.
mod common;

use common::{driver, params};
use nexo_driver_sdk::{Client, Value, protocol::ObjectParams};

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
    // The simple view of the navigator hides the engine's own schemas and administration.
    let system = |nodes: Vec<nexo_driver_sdk::protocol::TreeNode>| -> Vec<String> {
        nodes
            .into_iter()
            .filter(|node| node.system)
            .map(|node| node.name)
            .collect()
    };
    let hidden = system(
        client
            .tree(&path(name, &["shop", "schemas"]))
            .await
            .unwrap(),
    );
    assert_eq!(hidden, ["information_schema", "pg_catalog"]);
    let hidden = system(client.tree(&path(name, &["shop"])).await.unwrap());
    assert_eq!(hidden, ["roles", "tablespaces"]);
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
    // What a table lists only to be seen: the views on it, the keys that point to it, its
    // rules and its policies.
    assert_eq!(
        names(&client, name, &part("dependencies")).await,
        ["open_orders", "totals"]
    );
    let customers = ["shop", "schemas", "shop", "tables", "customers"];
    let of = |part: &'static str| [&customers[..], &[part]].concat();
    assert_eq!(
        names(&client, name, &of("references")).await,
        ["shop.orders"]
    );
    assert_eq!(
        names(&client, name, &of("rules")).await,
        ["customers_changed"]
    );
    assert_eq!(
        names(&client, name, &of("policies")).await,
        ["customers_read"]
    );
    assert!(names(&client, name, &part("rules")).await.is_empty());

    // An object describes itself; a function shows its body.
    let described = client.describe(&path(name, &orders)).await.unwrap();
    let columns = described
        .sections
        .iter()
        .find(|section| section.id == "columns")
        .unwrap();
    assert_eq!(columns.rows.len(), 4);
    // What the Properties view shows of a table besides its name and owner.
    let named = |name: &str| {
        described
            .properties
            .iter()
            .find(|p| p.name == name)
            .cloned()
    };
    assert_eq!(
        named("Persistence").map(|p| p.value),
        Some(Value::Text("permanent".into()))
    );
    for name in ["Object ID", "Table size", "Size"] {
        assert!(named(name).is_some(), "{name}: {:?}", described.properties);
    }
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
    // Both ends of a key, by column, so the interface follows it without reading SQL.
    let cell = |section: &nexo_driver_sdk::protocol::Section, column: &str| {
        let at = section
            .columns
            .iter()
            .position(|name| name == column)
            .unwrap();
        section.rows[0][at].clone()
    };
    assert_eq!(cell(by, "Columns"), Value::Text("customer".into()));
    assert_eq!(cell(by, "Table name"), Value::Text("orders".into()));
    let keys = described
        .sections
        .iter()
        .find(|section| section.id == "foreign-keys")
        .unwrap();
    assert_eq!(cell(keys, "Referenced schema"), Value::Text("shop".into()));
    assert_eq!(
        cell(keys, "Referenced table"),
        Value::Text("customers".into())
    );
    assert_eq!(cell(keys, "Referenced columns"), Value::Text("id".into()));
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
