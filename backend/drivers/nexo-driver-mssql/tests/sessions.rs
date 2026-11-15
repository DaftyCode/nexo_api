//! A session keeps its transactions, and a cancelled statement stops at once and leaves the
//! session answering each request with its own reply.
mod common;

use common::{driver, params, run, single};
use nexo_driver_sdk::{ErrorCode, Value, statements::ExecuteParams};

#[tokio::test]
async fn transactions_begin_and_roll_back() {
    use nexo_driver_sdk::statements::{TransactionAction, TransactionParams};
    let connect = fixture!(params("transactions"));
    let client = driver();
    client.connect(&connect).await.unwrap();
    let action = |action| TransactionParams {
        connection: "transactions".into(),
        action,
        isolation: None,
    };
    let begun = client
        .transaction(&action(TransactionAction::Begin))
        .await
        .unwrap();
    assert!(begun.open, "{begun:?}");
    run(
        &client,
        "transactions",
        "INSERT INTO shop.customers (email) VALUES (N'undone@example.com')",
    )
    .await
    .unwrap();
    let undone = client
        .transaction(&action(TransactionAction::Rollback))
        .await
        .unwrap();
    assert!(!undone.open, "{undone:?}");
    assert_eq!(
        single(
            &client,
            "transactions",
            "SELECT COUNT(*) FROM shop.customers WHERE email = N'undone@example.com'"
        )
        .await,
        Value::Integer(0)
    );
}

#[tokio::test]
async fn a_cancelled_statement_leaves_the_session_usable() {
    use nexo_driver_sdk::statements::CancelParams;
    let connect = fixture!(params("cancel"));
    let client = driver();
    client.connect(&connect).await.unwrap();
    // The session goes on on the database it changed to.
    run(&client, "cancel", "USE tempdb").await.unwrap();
    let running = {
        let client = client.clone();
        tokio::spawn(async move {
            client
                .execute(&ExecuteParams {
                    connection: "cancel".into(),
                    statement: "slow".into(),
                    sql: "WAITFOR DELAY '00:01:00'".into(),
                    params: Vec::new(),
                    page_rows: None,
                    max_rows: None,
                })
                .await
        })
    };
    tokio::time::sleep(std::time::Duration::from_millis(300)).await;
    let started = std::time::Instant::now();
    client
        .cancel(&CancelParams {
            connection: "cancel".into(),
            statement: "slow".into(),
        })
        .await
        .unwrap();
    let error = running.await.unwrap().unwrap_err();
    assert_eq!(error.code, ErrorCode::Cancelled, "{error:?}");
    assert!(started.elapsed().as_secs() < 5, "{:?}", started.elapsed());
    // Each reply answers its own request.
    for number in 1..=3 {
        assert_eq!(
            single(&client, "cancel", &format!("SELECT {number}")).await,
            Value::Integer(number)
        );
    }
    assert_eq!(
        single(&client, "cancel", "SELECT DB_NAME()").await,
        Value::Text("tempdb".into())
    );
    // A write that waits for a lock another session holds, cancelled too.
    let mut holder = connect.clone();
    holder.connection = "holder".into();
    client.connect(&holder).await.unwrap();
    use nexo_driver_sdk::statements::{TransactionAction, TransactionParams};
    let hold = |action| TransactionParams {
        connection: "holder".into(),
        action,
        isolation: None,
    };
    client
        .transaction(&hold(TransactionAction::Begin))
        .await
        .unwrap();
    run(
        &client,
        "holder",
        "UPDATE shop.shop.orders SET status = status",
    )
    .await
    .unwrap();
    let writing = {
        let client = client.clone();
        tokio::spawn(async move {
            client
                .execute(&ExecuteParams {
                    connection: "cancel".into(),
                    statement: "write".into(),
                    sql: "UPDATE shop.shop.orders SET status = status".into(),
                    params: Vec::new(),
                    page_rows: None,
                    max_rows: None,
                })
                .await
        })
    };
    tokio::time::sleep(std::time::Duration::from_millis(300)).await;
    client
        .cancel(&CancelParams {
            connection: "cancel".into(),
            statement: "write".into(),
        })
        .await
        .unwrap();
    assert_eq!(
        writing.await.unwrap().unwrap_err().code,
        ErrorCode::Cancelled
    );
    client
        .transaction(&hold(TransactionAction::Rollback))
        .await
        .unwrap();
    assert_eq!(
        single(&client, "cancel", "SELECT 4").await,
        Value::Integer(4)
    );
}
