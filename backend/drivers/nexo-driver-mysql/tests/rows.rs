//! Rows changed in the data grid, written by the MySQL driver against the fixture: edited
//! cells of three types, a new row and a deleted one in one transaction, and nothing saved
//! when one of the rows is missing.
mod common;

use common::{driver, params, run, single};
use nexo_driver_sdk::{
    Value, ValueKind,
    rows::{Cell, RowChange, RowsWriteParams},
};

fn cell(column: &str, value: Value) -> Cell {
    Cell {
        column: column.into(),
        value,
        default: false,
    }
}
fn key(id: i64) -> Vec<Cell> {
    vec![cell("id", Value::Integer(id))]
}
fn write(changes: Vec<RowChange>) -> RowsWriteParams {
    RowsWriteParams {
        connection: "rows".into(),
        schema: None,
        table: "grid_rows".into(),
        changes,
        optimistic: false,
    }
}

#[tokio::test]
async fn edited_new_and_deleted_rows_are_written_as_one_or_not_at_all() {
    let connect = fixture!(params("rows"));
    let client = driver();
    client.connect(&connect).await.unwrap();
    run(&client, "rows", "DROP TABLE IF EXISTS grid_rows")
        .await
        .unwrap();
    run(&client, "rows", "CREATE TABLE grid_rows (id int PRIMARY KEY, label varchar(50), total decimal(10, 2), at datetime, doc json, made datetime DEFAULT CURRENT_TIMESTAMP)").await.unwrap();
    run(
        &client,
        "rows",
        "INSERT INTO grid_rows (id, label) VALUES (1, 'a'), (2, 'b'), (3, 'c')",
    )
    .await
    .unwrap();
    let changes = vec![
        RowChange::Update {
            key: key(1),
            values: vec![
                cell("total", Value::typed(ValueKind::Decimal, "9.50")),
                cell(
                    "at",
                    Value::typed(ValueKind::Timestamp, "2026-11-16T10:00:00"),
                ),
                cell("doc", Value::typed(ValueKind::Json, "{\"gift\": true}")),
            ],
            original: Vec::new(),
        },
        RowChange::Insert {
            values: vec![
                cell("id", Value::Integer(4)),
                cell("label", Value::Text("d".into())),
                Cell {
                    column: "made".into(),
                    value: Value::Null,
                    default: true,
                },
            ],
        },
        RowChange::Delete {
            key: key(3),
            original: Vec::new(),
        },
    ];
    let written = client.rows_write(&write(changes)).await.unwrap();
    assert_eq!(written.affected, 3);
    let count = "SELECT COUNT(*) FROM grid_rows";
    assert_eq!(text(single(&client, "rows", count).await), "3");
    let total = "SELECT total FROM grid_rows WHERE id = 1";
    assert_eq!(text(single(&client, "rows", total).await), "9.50");
    let made = "SELECT made FROM grid_rows WHERE id = 4";
    assert_ne!(
        single(&client, "rows", made).await,
        Value::Null,
        "the default was given"
    );
    // Row 99 does not exist: the change of row 2 is undone with it.
    let failing = vec![
        RowChange::Update {
            key: key(2),
            values: vec![cell("label", Value::Text("changed".into()))],
            original: Vec::new(),
        },
        RowChange::Delete {
            key: key(99),
            original: Vec::new(),
        },
    ];
    let failed = client.rows_write(&write(failing)).await.unwrap_err();
    assert!(
        failed.message.starts_with("Change 2 was not saved"),
        "{failed}"
    );
    let label = "SELECT label FROM grid_rows WHERE id = 2";
    assert_eq!(
        single(&client, "rows", label).await,
        Value::Text("b".into())
    );
    run(&client, "rows", "DROP TABLE IF EXISTS grid_rows")
        .await
        .unwrap();
}

/// A number as its text, whatever class the engine gave it.
fn text(value: Value) -> String {
    match value {
        Value::Integer(number) => number.to_string(),
        Value::Text(text) | Value::Typed { text, .. } => text,
        other => format!("{other:?}"),
    }
}
