//! The structure editor of MySQL and MariaDB against the fixture: a table made from a model
//! with a primary key, a foreign key and an index reads back as the same model; a column's
//! type changed and another added; then dropped.
mod common;

use common::{driver, mariadb, params, run};
use nexo_driver_sdk::{
    Client,
    ddl::{
        ColumnModel, DdlModelParams, DdlPlanParams, ForeignKeyModel, IndexModel, KeyModel,
        TableModel,
    },
    protocol::ConnectParams,
};

fn column(name: &str, type_name: &str, nullable: bool) -> ColumnModel {
    ColumnModel {
        name: name.into(),
        type_name: type_name.into(),
        nullable,
        ..ColumnModel::default()
    }
}

async fn apply(client: &Client, original: Option<TableModel>, target: Option<TableModel>) {
    let planned = client
        .ddl_plan(&DdlPlanParams {
            connection: "edit".into(),
            original,
            target,
            cascade: false,
        })
        .await
        .unwrap();
    for statement in planned.statements {
        run(client, "edit", &statement).await.unwrap();
    }
}

async fn model(client: &Client, name: &str) -> TableModel {
    client
        .ddl_model(&DdlModelParams {
            connection: "edit".into(),
            path: ["databases", "shop", "tables", name]
                .map(String::from)
                .to_vec(),
        })
        .await
        .unwrap()
        .table
}

async fn check(connect: ConnectParams) {
    let client = driver();
    client.connect(&connect).await.unwrap();
    for sql in [
        "DROP TABLE IF EXISTS edit_orders",
        "DROP TABLE IF EXISTS edit_people",
        "CREATE TABLE edit_people (id int PRIMARY KEY)",
    ] {
        run(&client, "edit", sql).await.unwrap();
    }
    let new = TableModel {
        schema: Some("shop".into()),
        name: "edit_orders".into(),
        columns: vec![
            ColumnModel {
                identity: true,
                ..column("id", "int", false)
            },
            column("person", "int", true),
            ColumnModel {
                default: Some("'new'".into()),
                comment: Some("where it is".into()),
                ..column("status", "varchar(10)", true)
            },
        ],
        primary_key: Some(KeyModel {
            name: String::new(),
            columns: vec!["id".into()],
        }),
        foreign_keys: vec![ForeignKeyModel {
            name: "edit_orders_person".into(),
            columns: vec!["person".into()],
            referenced_table: "edit_people".into(),
            referenced_columns: vec!["id".into()],
            on_delete: "SET NULL".into(),
            ..ForeignKeyModel::default()
        }],
        indexes: vec![IndexModel {
            name: "edit_orders_status".into(),
            columns: vec!["status".into()],
            ..IndexModel::default()
        }],
        ..TableModel::default()
    };
    apply(&client, None, Some(new)).await;
    let table = model(&client, "edit_orders").await;
    assert_eq!(
        table
            .columns
            .iter()
            // MariaDB writes the display width of an integer: `int(11)`.
            .map(|c| (
                c.name.as_str(),
                c.type_name.trim_end_matches("(11)"),
                c.nullable
            ))
            .collect::<Vec<_>>(),
        [
            ("id", "int", false),
            ("person", "int", true),
            ("status", "varchar(10)", true)
        ]
    );
    assert!(table.columns[0].identity);
    assert_eq!(table.columns[2].default.as_deref(), Some("'new'"));
    assert_eq!(table.columns[2].comment.as_deref(), Some("where it is"));
    assert_eq!(table.primary_key.as_ref().unwrap().columns, ["id"]);
    assert_eq!(table.foreign_keys[0].on_delete, "SET NULL");
    assert_eq!(
        table
            .indexes
            .iter()
            .map(|i| i.name.as_str())
            .collect::<Vec<_>>(),
        ["edit_orders_status"]
    );

    let mut changed = table.clone();
    changed.columns[2].type_name = "varchar(40)".into();
    changed.columns.push(column("note", "text", true));
    apply(&client, Some(table), Some(changed)).await;
    let read = model(&client, "edit_orders").await;
    assert_eq!(read.columns[2].type_name, "varchar(40)");
    assert_eq!(read.columns[2].default.as_deref(), Some("'new'"));
    assert_eq!(read.columns[3].type_name, "text");

    apply(&client, Some(read), None).await;
    run(&client, "edit", "DROP TABLE edit_people")
        .await
        .unwrap();
}

#[tokio::test]
async fn mysql_tables_are_made_changed_and_dropped_from_models() {
    check(fixture!(params("edit"))).await;
}

#[tokio::test]
async fn mariadb_tables_are_made_changed_and_dropped_from_models() {
    check(fixture!(mariadb("edit"))).await;
}
