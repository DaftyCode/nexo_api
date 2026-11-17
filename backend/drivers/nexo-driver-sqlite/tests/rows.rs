//! Rows changed in the data grid, written by the SQLite driver: three cells, a new row and a
//! deleted one in one transaction; nothing when another session deleted a row first; inside a
//! manual transaction, behind a savepoint; and the types of what was edited kept.
mod common;

use common::{Folder, SHOP, database, driver, params, run, single};
use nexo_driver_sdk::{
    Client, ErrorCode, Value, ValueKind,
    rows::{Cell, RowChange, RowsWriteParams},
    statements::{TransactionAction, TransactionParams},
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
fn write(connection: &str, changes: Vec<RowChange>) -> RowsWriteParams {
    RowsWriteParams {
        connection: connection.into(),
        schema: None,
        table: "orders".into(),
        changes,
        optimistic: false,
    }
}
async fn rows(client: &Client, connection: &str) -> Vec<Vec<Value>> {
    run(
        client,
        connection,
        "SELECT id, status, total, note FROM orders ORDER BY id",
    )
    .await
    .unwrap()
    .rows
}

#[tokio::test]
async fn edited_cells_new_and_deleted_rows_are_written_as_one() {
    let folder = Folder::new("rows");
    let path = database(&folder, "shop.db", SHOP);
    let client = driver();
    client.connect(&params("rows", &path)).await.unwrap();
    let changes = vec![
        RowChange::Update {
            key: key(1),
            values: vec![
                cell("total", Value::typed(ValueKind::Decimal, "130.25")),
                cell("note", Value::Text("{\"gift\": true}".into())),
            ],
            original: Vec::new(),
        },
        RowChange::Update {
            key: key(2),
            values: vec![cell("status", Value::Text("paid".into()))],
            original: Vec::new(),
        },
        RowChange::Insert {
            values: vec![
                cell("customer", Value::Integer(2)),
                cell("status", Value::Text("sent".into())),
                Cell {
                    column: "total".into(),
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
    let written = client.rows_write(&write("rows", changes)).await.unwrap();
    assert_eq!(written.affected, 4);
    assert_eq!(
        written.statements[0],
        "UPDATE \"orders\" SET \"total\" = ?, \"note\" = ? WHERE \"id\" = ?"
    );
    let found = rows(&client, "rows").await;
    assert_eq!(found.len(), 3);
    // The decimal column takes the edited text as a number; the trigger ran for the status.
    assert_eq!(found[0][2], Value::Float(130.25));
    assert_eq!(found[0][3], Value::Text("{\"gift\": true}".into()));
    assert_eq!(found[1][3], Value::Text("touched".into()));
    assert_eq!(
        found[2][..2],
        [Value::Integer(4), Value::Text("sent".into())]
    );
    assert_eq!(found[2][2], Value::Null);
}

#[tokio::test]
async fn a_row_another_session_deleted_saves_nothing() {
    let folder = Folder::new("gone");
    let path = database(&folder, "shop.db", SHOP);
    let client = driver();
    client.connect(&params("mine", &path)).await.unwrap();
    client.connect(&params("other", &path)).await.unwrap();
    let before = rows(&client, "mine").await;
    run(&client, "other", "DELETE FROM orders WHERE id = 2")
        .await
        .unwrap();
    let changes = vec![
        RowChange::Update {
            key: key(1),
            values: vec![cell("status", Value::Text("sent".into()))],
            original: Vec::new(),
        },
        RowChange::Update {
            key: key(2),
            values: vec![cell("status", Value::Text("sent".into()))],
            original: Vec::new(),
        },
    ];
    let failed = client
        .rows_write(&write("mine", changes))
        .await
        .unwrap_err();
    assert_eq!(failed.code, ErrorCode::Invalid);
    assert!(
        failed.message.starts_with("Change 2 was not saved"),
        "{failed}"
    );
    let after = rows(&client, "mine").await;
    assert_eq!(after[0], before[0], "the first change was undone too");
    // Optimistic: a value another session changed is not overwritten.
    run(
        &client,
        "other",
        "UPDATE orders SET status = 'sent' WHERE id = 1",
    )
    .await
    .unwrap();
    let mut careful = write(
        "mine",
        vec![RowChange::Update {
            key: key(1),
            values: vec![cell("status", Value::Text("paid".into()))],
            original: vec![cell("status", Value::Text("paid".into()))],
        }],
    );
    careful.optimistic = true;
    assert!(client.rows_write(&careful).await.is_err());
}

#[tokio::test]
async fn in_manual_commit_a_save_waits_for_the_commit() {
    let folder = Folder::new("manual");
    let path = database(&folder, "shop.db", SHOP);
    let client = driver();
    client.connect(&params("manual", &path)).await.unwrap();
    client.connect(&params("reader", &path)).await.unwrap();
    let manual = TransactionParams {
        connection: "manual".into(),
        action: TransactionAction::Manual,
        isolation: None,
    };
    client.transaction(&manual).await.unwrap();
    run(
        &client,
        "manual",
        "UPDATE orders SET note = 'first' WHERE id = 1",
    )
    .await
    .unwrap();
    let changes = vec![
        RowChange::Update {
            key: key(1),
            values: vec![cell("note", Value::Text("second".into()))],
            original: Vec::new(),
        },
        RowChange::Delete {
            key: key(99),
            original: Vec::new(),
        },
    ];
    // The failed save goes back to its savepoint: the earlier statement stays pending.
    assert!(client.rows_write(&write("manual", changes)).await.is_err());
    let note = "SELECT note FROM orders WHERE id = 1";
    assert_eq!(
        single(&client, "manual", note).await,
        Value::Text("first".into())
    );
    let saved = vec![RowChange::Update {
        key: key(1),
        values: vec![cell("note", Value::Text("second".into()))],
        original: Vec::new(),
    }];
    client.rows_write(&write("manual", saved)).await.unwrap();
    assert_eq!(single(&client, "reader", note).await, Value::Null);
    let commit = TransactionParams {
        action: TransactionAction::Commit,
        ..manual
    };
    client.transaction(&commit).await.unwrap();
    assert_eq!(
        single(&client, "reader", note).await,
        Value::Text("second".into())
    );
}
