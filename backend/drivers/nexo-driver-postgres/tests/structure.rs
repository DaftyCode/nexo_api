//! The structure editor of PostgreSQL against the fixture: a table made from a model with a
//! primary key, a foreign key and an index reads back as the same model; a column's type
//! changed and another added; then dropped. User types come in the list of types.
mod common;

use common::{driver, params, run};
use nexo_driver_sdk::{
    Client,
    ddl::{
        ColumnModel, DdlModelParams, DdlPlanParams, ForeignKeyModel, IndexModel, KeyModel,
        TableModel,
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

async fn model(client: &Client, name: &str) -> nexo_driver_sdk::ddl::DdlModel {
    client
        .ddl_model(&DdlModelParams {
            connection: "edit".into(),
            path: ["shop", "schemas", "public", "tables", name]
                .map(String::from)
                .to_vec(),
        })
        .await
        .unwrap()
}

#[tokio::test]
async fn a_table_made_from_a_model_reads_back_and_changes() {
    let connect = fixture!(params("edit", None));
    let client = driver();
    client.connect(&connect).await.unwrap();
    for sql in [
        "DROP TABLE IF EXISTS public.edit_orders, public.edit_people",
        "DROP TYPE IF EXISTS public.edit_mood",
        "CREATE TYPE public.edit_mood AS ENUM ('ok', 'sad')",
        "CREATE TABLE public.edit_people (id int PRIMARY KEY)",
    ] {
        run(&client, "edit", sql).await.unwrap();
    }
    let new = TableModel {
        schema: Some("public".into()),
        name: "edit_orders".into(),
        columns: vec![
            ColumnModel {
                identity: true,
                ..column("id", "integer", false)
            },
            column("person", "integer", true),
            ColumnModel {
                default: Some("'ok'::edit_mood".into()),
                comment: Some("how it went".into()),
                ..column("mood", "edit_mood", true)
            },
        ],
        primary_key: Some(KeyModel {
            name: "edit_orders_pkey".into(),
            columns: vec!["id".into()],
        }),
        foreign_keys: vec![ForeignKeyModel {
            name: "edit_orders_person".into(),
            columns: vec!["person".into()],
            referenced_schema: Some("public".into()),
            referenced_table: "edit_people".into(),
            referenced_columns: vec!["id".into()],
            on_delete: "SET NULL".into(),
            ..ForeignKeyModel::default()
        }],
        indexes: vec![IndexModel {
            name: "edit_orders_mood".into(),
            columns: vec!["mood".into()],
            ..IndexModel::default()
        }],
        ..TableModel::default()
    };
    apply(&client, None, Some(new)).await;
    let read = model(&client, "edit_orders").await;
    assert!(read.types.iter().any(|name| name == "edit_mood"));
    assert!(read.types.iter().any(|name| name == "integer"));
    let table = read.table;
    assert_eq!(
        table
            .columns
            .iter()
            .map(|c| (c.name.as_str(), c.type_name.as_str(), c.nullable))
            .collect::<Vec<_>>(),
        [
            ("id", "integer", false),
            ("person", "integer", true),
            ("mood", "edit_mood", true)
        ]
    );
    assert!(table.columns[0].identity);
    assert_eq!(table.columns[2].default.as_deref(), Some("'ok'::edit_mood"));
    assert_eq!(table.columns[2].comment.as_deref(), Some("how it went"));
    assert_eq!(table.primary_key.as_ref().unwrap().columns, ["id"]);
    assert_eq!(table.foreign_keys[0].on_delete, "SET NULL");
    assert_eq!(table.foreign_keys[0].referenced_table, "edit_people");
    assert_eq!(table.indexes[0].columns, ["mood"]);

    // The type of a column changed, another added; the model read back has both.
    let mut changed = table.clone();
    changed.columns[1].type_name = "bigint".into();
    changed.columns.push(column("note", "varchar(40)", true));
    apply(&client, Some(table), Some(changed)).await;
    let read = model(&client, "edit_orders").await.table;
    assert_eq!(read.columns[1].type_name, "bigint");
    assert_eq!(read.columns[3].type_name, "character varying(40)");

    apply(&client, Some(read), None).await;
    run(&client, "edit", "DROP TABLE public.edit_people")
        .await
        .unwrap();
    run(&client, "edit", "DROP TYPE public.edit_mood")
        .await
        .unwrap();
}
