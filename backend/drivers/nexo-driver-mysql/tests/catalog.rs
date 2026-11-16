//! The tree, the description and the DDL of what MySQL and MariaDB have, against the fixture's
//! data: the DDL of two related tables recreates them the same in another database.
mod common;

use common::{driver, mariadb, params, run};
use nexo_driver_sdk::{
    Client, Value,
    protocol::{ObjectDescription, ObjectParams, Section},
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

async fn labels(client: &Client, connection: &str, segments: &[&str]) -> Vec<String> {
    let nodes = client.tree(&path(connection, segments)).await.unwrap();
    nodes.into_iter().map(|node| node.label).collect()
}

fn section<'a>(object: &'a ObjectDescription, id: &str) -> &'a Section {
    object.sections.iter().find(|s| s.id == id).unwrap()
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
    for (connect, maria) in [(params("tree"), false), (mariadb("tree"), true)] {
        let connect = fixture!(connect);
        let client = driver();
        client.connect(&connect).await.unwrap();
        let name = "tree";
        assert_eq!(
            labels(&client, name, &[]).await,
            ["Databases", "Users", "Administration"]
        );
        let databases = client.tree(&path(name, &["databases"])).await.unwrap();
        assert!(databases.iter().any(|db| db.name == "shop" && !db.system));
        assert!(databases.iter().any(|db| db.name == "mysql" && db.system));
        let folders = labels(&client, name, &["databases", "shop"]).await;
        assert_eq!(
            folders.contains(&"Sequences".to_owned()),
            maria,
            "{folders:?}"
        );
        let shop = |folder: &'static str| ["databases", "shop", folder];
        assert_eq!(
            labels(&client, name, &shop("tables")).await,
            ["customers", "every_type", "numbers", "orders", "zero_dates"]
        );
        assert_eq!(labels(&client, name, &shop("views")).await, ["open_orders"]);
        assert_eq!(
            labels(&client, name, &shop("procedures")).await,
            ["mark_sent", "two_results"]
        );
        assert_eq!(
            labels(&client, name, &shop("functions")).await,
            ["order_count"]
        );
        assert_eq!(
            labels(&client, name, &shop("triggers")).await,
            ["orders_touch"]
        );
        assert_eq!(labels(&client, name, &shop("events")).await, ["nightly"]);
        assert!(
            labels(&client, name, &shop("indexes"))
                .await
                .contains(&"orders_status".to_owned())
        );
        let tables = client.tree(&path(name, &shop("tables"))).await.unwrap();
        let numbers = tables.iter().find(|table| table.name == "numbers").unwrap();
        assert!(
            numbers
                .detail
                .as_deref()
                .is_some_and(|detail| detail.ends_with(" rows"))
        );
        let orders = ["databases", "shop", "tables", "orders"];
        let part = |part: &'static str| [&orders[..], &[part]].concat();
        assert_eq!(
            labels(&client, name, &part("columns")).await,
            ["id", "customer", "status", "total"]
        );
        assert_eq!(
            labels(&client, name, &part("constraints")).await,
            ["orders_total_small", "PRIMARY"]
        );
        assert_eq!(
            labels(&client, name, &part("foreign-keys")).await,
            ["orders_customer_fkey"]
        );
        assert_eq!(labels(&client, name, &part("indexes")).await[0], "PRIMARY");
        assert_eq!(
            labels(&client, name, &part("triggers")).await,
            ["orders_touch"]
        );
        let customers = ["databases", "shop", "tables", "customers", "references"];
        assert_eq!(labels(&client, name, &customers).await, ["shop.orders"]);
        // The server: its users and its settings.
        assert!(
            labels(&client, name, &["users"])
                .await
                .contains(&"root@%".to_owned())
        );
        let variables = labels(&client, name, &["administration", "session-variables"]).await;
        assert!(variables.contains(&"autocommit".to_owned()));
        assert!(
            labels(&client, name, &["administration", "engines"])
                .await
                .contains(&"InnoDB".to_owned())
        );
    }
}

#[tokio::test]
async fn objects_describe_themselves() {
    for connect in [params("describe"), mariadb("describe")] {
        let connect = fixture!(connect);
        let client = driver();
        client.connect(&connect).await.unwrap();
        let name = "describe";
        let orders = client
            .describe(&path(name, &["databases", "shop", "tables", "orders"]))
            .await
            .unwrap();
        assert_eq!(
            (orders.kind.as_str(), orders.name.as_str()),
            ("table", "shop.orders")
        );
        let property = |key: &str| {
            orders
                .properties
                .iter()
                .find(|p| p.name == key)
                .map(|p| p.value.clone())
        };
        assert_eq!(property("Engine"), Some(Value::Text("InnoDB".into())));
        assert!(property("Size").is_some() && property("Table size").is_some());
        assert_eq!(section(&orders, "columns").rows.len(), 4);
        let keys = section(&orders, "foreign-keys");
        assert_eq!(cell(keys, "Columns"), Value::Text("customer".into()));
        assert_eq!(cell(keys, "Referenced schema"), Value::Text("shop".into()));
        assert_eq!(
            cell(keys, "Referenced table"),
            Value::Text("customers".into())
        );
        assert_eq!(cell(keys, "Referenced columns"), Value::Text("id".into()));
        let checks = section(&orders, "constraints");
        assert!(
            checks
                .rows
                .iter()
                .any(|row| row[0] == Value::Text("orders_total_small".into()))
        );
        let customers = client
            .describe(&path(name, &["databases", "shop", "tables", "customers"]))
            .await
            .unwrap();
        let by = section(&customers, "references");
        assert_eq!(cell(by, "Table name"), Value::Text("orders".into()));
        assert!(
            customers
                .properties
                .iter()
                .any(|p| p.value == Value::Text("People who buy".into()))
        );
        let view = client
            .describe(&path(name, &["databases", "shop", "views", "open_orders"]))
            .await
            .unwrap();
        assert_eq!(view.kind, "view");
        assert!(view.properties.iter().any(|p| p.name == "Definition"));
        for (folder, routine, text) in [
            ("functions", "order_count", "COUNT(*)"),
            ("procedures", "two_results", "SELECT 1"),
        ] {
            let described = client
                .describe(&path(name, &["databases", "shop", folder, routine]))
                .await
                .unwrap();
            let definition = described
                .properties
                .iter()
                .find(|p| p.name == "Definition")
                .unwrap();
            assert!(
                matches!(&definition.value, Value::Text(body) if body.contains(text)),
                "{definition:?}"
            );
        }
        let grants = client
            .describe(&path(name, &["users", "root@%"]))
            .await
            .unwrap();
        assert!(!section(&grants, "grants").rows.is_empty());
    }
}

#[tokio::test]
async fn the_ddl_of_two_tables_recreates_them() {
    for connect in [params("ddl"), mariadb("ddl")] {
        let connect = fixture!(connect);
        let client = driver();
        client.connect(&connect).await.unwrap();
        let name = "ddl";
        let table = |table: &'static str| path(name, &["databases", "shop", "tables", table]);
        let customers = client.ddl(&table("customers")).await.unwrap().sql;
        let orders = client.ddl(&table("orders")).await.unwrap().sql;
        assert!(orders.starts_with("CREATE TABLE `orders`"), "{orders}");
        run(&client, name, "DROP DATABASE IF EXISTS ddl_copy")
            .await
            .unwrap();
        run(&client, name, "CREATE DATABASE ddl_copy")
            .await
            .unwrap();
        run(&client, name, "USE ddl_copy").await.unwrap();
        run(&client, name, customers.trim_end_matches(';'))
            .await
            .unwrap();
        run(&client, name, orders.trim_end_matches(';'))
            .await
            .unwrap();
        let copy = client
            .ddl(&path(name, &["databases", "ddl_copy", "tables", "orders"]))
            .await
            .unwrap()
            .sql;
        run(&client, name, "DROP DATABASE ddl_copy").await.unwrap();
        // The copy is the same table, its counter left aside.
        let plain = |text: &str| {
            text.split_whitespace()
                .filter(|word| !word.starts_with("AUTO_INCREMENT="))
                .collect::<Vec<_>>()
                .join(" ")
        };
        assert_eq!(plain(&copy), plain(&orders));
        for (segments, start) in [
            (vec!["databases", "shop"], "CREATE DATABASE"),
            (vec!["databases", "shop", "views", "open_orders"], "CREATE "),
            (
                vec!["databases", "shop", "procedures", "two_results"],
                "CREATE ",
            ),
            (
                vec!["databases", "shop", "triggers", "orders_touch"],
                "CREATE ",
            ),
            (vec!["databases", "shop", "events", "nightly"], "CREATE "),
            (
                vec!["databases", "shop", "indexes", "orders.orders_status"],
                "ALTER TABLE `shop`.`orders` ADD INDEX",
            ),
            (vec!["users", "root@%"], "CREATE USER"),
        ] {
            let sql = client.ddl(&path(name, &segments)).await.unwrap().sql;
            assert!(sql.starts_with(start), "{segments:?}: {sql}");
        }
    }
}
