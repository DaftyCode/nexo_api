//! The tree, the descriptions and the DDL of a SQLite file, and the types of its values.
mod common;

use common::{Folder, SHOP, database, driver, params, run};
use nexo_driver_sdk::{
    Client, Value, ValueKind,
    protocol::{ObjectParams, TreeNode},
};

async fn tree(client: &Client, path: &[&str]) -> Vec<TreeNode> {
    let params = ObjectParams {
        connection: "catalog".into(),
        path: path.iter().map(|segment| (*segment).to_owned()).collect(),
    };
    client.tree(&params).await.unwrap()
}
fn names(nodes: &[TreeNode]) -> Vec<&str> {
    nodes.iter().map(|node| node.name.as_str()).collect()
}
fn object(path: &[&str]) -> ObjectParams {
    ObjectParams {
        connection: "catalog".into(),
        path: path.iter().map(|segment| (*segment).to_owned()).collect(),
    }
}

#[tokio::test]
async fn the_tree_shows_the_objects_of_the_file() {
    let folder = Folder::new("tree");
    let path = database(&folder, "shop.db", SHOP);
    let client = driver();
    client.connect(&params("catalog", &path)).await.unwrap();
    assert_eq!(
        names(&tree(&client, &[]).await),
        ["tables", "views", "indexes", "triggers"]
    );
    let tables = tree(&client, &["tables"]).await;
    let shown: Vec<&str> = tables
        .iter()
        .filter(|node| !node.system)
        .map(|node| node.name.as_str())
        .collect();
    assert_eq!(shown, ["customers", "docs", "numbers", "orders"]);
    let docs = tables.iter().find(|node| node.name == "docs").unwrap();
    assert_eq!(docs.detail.as_deref(), Some("fts5"));
    // SQLite's own tables and the shadow tables of a virtual one are for the full view.
    assert!(
        tables
            .iter()
            .any(|node| node.name == "docs_data" && node.system)
    );
    assert_eq!(docs.actions, ["open", "data", "ddl"]);
    assert_eq!(names(&tree(&client, &["views"]).await), ["open_orders"]);
    let indexes = tree(&client, &["indexes"]).await;
    let orders_status = indexes
        .iter()
        .find(|node| node.name == "orders_status")
        .unwrap();
    assert_eq!(orders_status.detail.as_deref(), Some("orders"));
    assert!(
        indexes
            .iter()
            .any(|node| node.name.starts_with("sqlite_autoindex") && node.system)
    );
    assert_eq!(names(&tree(&client, &["triggers"]).await), ["orders_touch"]);
    let parts = tree(&client, &["tables", "orders"]).await;
    assert_eq!(
        names(&parts),
        [
            "columns",
            "foreign-keys",
            "indexes",
            "references",
            "triggers"
        ]
    );
    let columns = tree(&client, &["tables", "orders", "columns"]).await;
    assert_eq!(
        names(&columns),
        ["id", "customer", "total", "status", "note"]
    );
    assert_eq!(columns[2].detail.as_deref(), Some("DECIMAL(10, 2)"));
    let keys = tree(&client, &["tables", "orders", "foreign-keys"]).await;
    assert_eq!(keys[0].label, "customer → customers");
    let references = tree(&client, &["tables", "customers", "references"]).await;
    assert_eq!(names(&references), ["orders"]);
    let triggers = tree(&client, &["tables", "orders", "triggers"]).await;
    assert_eq!(names(&triggers), ["orders_touch"]);
    let view = tree(&client, &["views", "open_orders", "columns"]).await;
    assert_eq!(names(&view), ["id", "customer", "total"]);
    let unknown = ObjectParams {
        connection: "catalog".into(),
        path: vec!["schemas".into()],
    };
    assert!(client.tree(&unknown).await.is_err());
}

#[tokio::test]
async fn objects_are_described_and_give_their_ddl() {
    let folder = Folder::new("describe");
    let path = database(&folder, "shop.db", SHOP);
    let client = driver();
    client.connect(&params("catalog", &path)).await.unwrap();
    let orders = client
        .describe(&object(&["tables", "orders"]))
        .await
        .unwrap();
    assert_eq!(orders.kind, "table");
    let sections: Vec<&str> = orders.sections.iter().map(|s| s.id.as_str()).collect();
    assert_eq!(
        sections,
        [
            "columns",
            "indexes",
            "foreign-keys",
            "references",
            "triggers"
        ]
    );
    let columns = &orders.sections[0];
    assert_eq!(columns.columns[..4], ["#", "Name", "Type", "Nullable"]);
    assert_eq!(columns.rows[1][1], Value::Text("customer".into()));
    assert_eq!(columns.rows[1][3], Value::Text("NO".into()));
    let keys = &orders.sections[2];
    let at = |name: &str| {
        keys.columns
            .iter()
            .position(|column| column == name)
            .unwrap()
    };
    assert_eq!(
        keys.rows[0][at("Referenced table")],
        Value::Text("customers".into())
    );
    assert_eq!(keys.rows[0][at("On delete")], Value::Text("CASCADE".into()));
    let customers = client
        .describe(&object(&["tables", "customers"]))
        .await
        .unwrap();
    let referenced = &customers.sections[3];
    assert_eq!(referenced.rows.len(), 1);
    let docs = client.describe(&object(&["tables", "docs"])).await.unwrap();
    assert!(
        docs.properties
            .iter()
            .any(|p| p.name == "Module" && p.value == Value::Text("fts5".into()))
    );
    let view = client
        .describe(&object(&["views", "open_orders"]))
        .await
        .unwrap();
    assert_eq!(view.kind, "view");
    assert!(view.properties.iter().any(|p| p.name == "Definition"));
    let index = client
        .describe(&object(&["indexes", "orders_status"]))
        .await
        .unwrap();
    assert_eq!(index.sections[0].rows[0][1], Value::Text("status".into()));
    let trigger = client
        .describe(&object(&["tables", "orders", "triggers", "orders_touch"]))
        .await
        .unwrap();
    assert_eq!(trigger.kind, "trigger");
    let column = client
        .describe(&object(&["tables", "customers", "columns", "created"]))
        .await
        .unwrap();
    assert!(column.properties.iter().any(|p| p.name == "Default"));

    let ddl = client
        .ddl(&object(&["tables", "orders"]))
        .await
        .unwrap()
        .sql;
    assert!(ddl.starts_with("CREATE TABLE orders ("), "{ddl}");
    assert!(
        ddl.contains("CREATE INDEX orders_status ON orders (status);"),
        "{ddl}"
    );
    assert!(ddl.contains("CREATE TRIGGER orders_touch"), "{ddl}");
    let automatic = client
        .tree(&object(&["tables", "customers", "indexes"]))
        .await
        .unwrap();
    let made = &automatic[0].name;
    let ddl = client.ddl(&object(&["indexes", made])).await.unwrap().sql;
    assert!(ddl.starts_with("-- SQLite made"), "{ddl}");
}

#[tokio::test]
async fn each_value_has_its_class_and_each_column_its_declared_type_and_origin() {
    let folder = Folder::new("types");
    let path = database(
        &folder,
        "types.db",
        &format!(
            "{SHOP}
            CREATE TABLE mixed (id INTEGER PRIMARY KEY, anything, flag BOOLEAN, at DATETIME, data BLOB);
            INSERT INTO mixed VALUES (1, 'text', 1, '2026-11-16 10:00:00', X'0102'),
                (2, 2.5, 0, 1763287200, NULL), (3, 7, NULL, NULL, 'not a blob');"
        ),
    );
    let client = driver();
    client.connect(&params("catalog", &path)).await.unwrap();
    let result = run(
        &client,
        "catalog",
        "SELECT m.*, m.id * 2 AS twice FROM mixed m ORDER BY id",
    )
    .await
    .unwrap();
    let kinds: Vec<(&str, ValueKind, bool)> = result
        .columns
        .iter()
        .map(|column| (column.type_name.as_str(), column.kind, column.key))
        .collect();
    assert_eq!(
        kinds,
        [
            ("INTEGER", ValueKind::Integer, true),
            ("", ValueKind::Other, false),
            ("BOOLEAN", ValueKind::Boolean, false),
            ("DATETIME", ValueKind::Text, false),
            ("BLOB", ValueKind::Binary, false),
            ("INTEGER", ValueKind::Integer, false),
        ]
    );
    let origin = result.columns[1].origin.as_ref().unwrap();
    assert_eq!(
        (origin.table.as_str(), origin.column.as_str()),
        ("mixed", "anything")
    );
    assert!(result.columns[5].origin.is_none());
    // A column of no type holds what each row put in it; dates are shown as they are kept.
    let anything: Vec<&Value> = result.rows.iter().map(|row| &row[1]).collect();
    assert_eq!(
        anything,
        [
            &Value::Text("text".into()),
            &Value::Float(2.5),
            &Value::Integer(7)
        ]
    );
    assert_eq!(result.rows[1][3], Value::Integer(1_763_287_200));
    assert_eq!(result.rows[0][4], Value::bytes(&[1, 2]));
    assert_eq!(result.rows[2][4], Value::Text("not a blob".into()));
}
