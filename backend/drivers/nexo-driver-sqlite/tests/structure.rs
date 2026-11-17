//! The structure editor of SQLite: a table made from a model with a primary key, a foreign
//! key and an index reads back as the same model; a change of type rebuilds the table and
//! keeps its rows, its checks and its indexes; a dropped table is gone.
mod common;

use common::{Folder, database, driver, params, run, single};
use nexo_driver_sdk::{
    Client, Value,
    ddl::{
        CheckModel, ColumnModel, DdlModelParams, DdlPlanParams, ForeignKeyModel, IndexModel,
        KeyModel, TableModel,
    },
};

fn column(name: &str, type_name: &str, nullable: bool) -> ColumnModel {
    ColumnModel {
        name: name.into(),
        type_name: type_name.into(),
        nullable,
        ..ColumnModel::default()
    }
}

async fn apply(
    client: &Client,
    original: Option<TableModel>,
    target: Option<TableModel>,
) -> Vec<String> {
    let planned = client
        .ddl_plan(&DdlPlanParams {
            connection: "edit".into(),
            original,
            target,
            cascade: false,
        })
        .await
        .unwrap();
    for statement in &planned.statements {
        run(client, "edit", statement).await.unwrap();
    }
    planned.warnings
}

async fn model(client: &Client, name: &str) -> TableModel {
    client
        .ddl_model(&DdlModelParams {
            connection: "edit".into(),
            path: vec!["tables".into(), name.into()],
        })
        .await
        .unwrap()
        .table
}

#[tokio::test]
async fn tables_are_made_rebuilt_with_their_rows_and_dropped() {
    let folder = Folder::new("structure");
    let path = database(
        &folder,
        "edit.db",
        "CREATE TABLE people (id INTEGER PRIMARY KEY);",
    );
    let client = driver();
    client.connect(&params("edit", &path)).await.unwrap();
    let new = TableModel {
        name: "orders".into(),
        columns: vec![
            ColumnModel {
                identity: true,
                ..column("id", "INTEGER", false)
            },
            column("person", "INTEGER", true),
            ColumnModel {
                default: Some("'new'".into()),
                ..column("status", "TEXT", false)
            },
        ],
        primary_key: Some(KeyModel {
            name: String::new(),
            columns: vec!["id".into()],
        }),
        checks: vec![CheckModel {
            name: "status_known".into(),
            expression: "status IN ('new', 'paid')".into(),
        }],
        foreign_keys: vec![ForeignKeyModel {
            columns: vec!["person".into()],
            referenced_table: "people".into(),
            referenced_columns: vec!["id".into()],
            on_delete: "CASCADE".into(),
            ..ForeignKeyModel::default()
        }],
        indexes: vec![IndexModel {
            name: "orders_status".into(),
            columns: vec!["status".into()],
            ..IndexModel::default()
        }],
        ..TableModel::default()
    };
    apply(&client, None, Some(new)).await;
    run(&client, "edit", "INSERT INTO people VALUES (1)")
        .await
        .unwrap();
    run(
        &client,
        "edit",
        "INSERT INTO orders (person, status) VALUES (1, 'paid'), (1, 'new')",
    )
    .await
    .unwrap();
    let table = model(&client, "orders").await;
    assert!(table.columns[0].identity);
    assert_eq!(table.columns[2].default.as_deref(), Some("'new'"));
    assert!(!table.columns[2].nullable);
    assert_eq!(table.checks[0].name, "status_known");
    assert_eq!(table.foreign_keys[0].on_delete, "CASCADE");
    assert_eq!(table.indexes[0].name, "orders_status");

    // A new type rebuilds the table: its rows, check and index stay.
    let mut changed = table.clone();
    changed.columns[2].type_name = "VARCHAR(10)".into();
    let warnings = apply(&client, Some(table), Some(changed)).await;
    assert!(
        warnings
            .iter()
            .any(|warning| warning.contains("created again"))
    );
    let read = model(&client, "orders").await;
    assert_eq!(read.columns[2].type_name, "VARCHAR(10)");
    assert_eq!(read.checks.len(), 1);
    assert_eq!(read.indexes[0].name, "orders_status");
    assert_eq!(
        single(&client, "edit", "SELECT count(*) FROM orders").await,
        Value::Integer(2)
    );
    let refused = run(
        &client,
        "edit",
        "INSERT INTO orders (person, status) VALUES (1, 'lost')",
    )
    .await;
    assert!(refused.is_err(), "the check is still there");

    apply(&client, Some(read), None).await;
    let left = single(
        &client,
        "edit",
        "SELECT count(*) FROM sqlite_schema WHERE name = 'orders'",
    )
    .await;
    assert_eq!(left, Value::Integer(0));
}
