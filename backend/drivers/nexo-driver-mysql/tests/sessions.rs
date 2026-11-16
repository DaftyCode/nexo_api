//! A session keeps its transactions, by hand or in manual mode, and a cancelled statement
//! stops at once and leaves the session answering each request with its own reply.
mod common;

use common::{driver, mariadb, params, run, single};
use nexo_driver_sdk::{
    ErrorCode, Value,
    statements::{CancelParams, ExecuteParams, TransactionAction, TransactionParams},
};

#[tokio::test]
async fn transactions_begin_roll_back_and_run_by_hand() {
    for connect in [params("transactions"), mariadb("transactions")] {
        let connect = fixture!(connect);
        let client = driver();
        client.connect(&connect).await.unwrap();
        let action = |action| TransactionParams {
            connection: "transactions".into(),
            action,
            isolation: None,
        };
        let begun = client
            .transaction(&TransactionParams {
                isolation: Some("serializable".into()),
                ..action(TransactionAction::Begin)
            })
            .await
            .unwrap();
        assert!(begun.open, "{begun:?}");
        let insert = "INSERT INTO customers (email) VALUES ('undone@example.com')";
        run(&client, "transactions", insert).await.unwrap();
        let undone = client
            .transaction(&action(TransactionAction::Rollback))
            .await
            .unwrap();
        assert!(!undone.open, "{undone:?}");
        let count = "SELECT COUNT(*) FROM customers WHERE email = 'undone@example.com'";
        assert_eq!(
            single(&client, "transactions", count).await,
            Value::Integer(0)
        );
        // Manual mode: the first statement opens a transaction that stays until it ends.
        let manual = client
            .transaction(&action(TransactionAction::Manual))
            .await
            .unwrap();
        assert!(!manual.auto_commit && !manual.open, "{manual:?}");
        run(&client, "transactions", insert).await.unwrap();
        let status = client
            .transaction(&action(TransactionAction::Status))
            .await
            .unwrap();
        assert!(status.open, "{status:?}");
        client
            .transaction(&action(TransactionAction::Rollback))
            .await
            .unwrap();
        let auto = client
            .transaction(&action(TransactionAction::Auto))
            .await
            .unwrap();
        assert!(auto.auto_commit && !auto.open, "{auto:?}");
        assert_eq!(
            single(&client, "transactions", count).await,
            Value::Integer(0)
        );
    }
}

#[tokio::test]
async fn a_cancelled_statement_leaves_the_session_usable() {
    for connect in [params("cancel"), mariadb("cancel")] {
        let connect = fixture!(connect);
        let client = driver();
        client.connect(&connect).await.unwrap();
        // The session goes on on the database it changed to.
        run(&client, "cancel", "USE information_schema")
            .await
            .unwrap();
        let running = {
            let client = client.clone();
            tokio::spawn(async move {
                client
                    .execute(&ExecuteParams {
                        connection: "cancel".into(),
                        statement: "slow".into(),
                        sql: "SELECT SLEEP(60)".into(),
                        params: Vec::new(),
                        page_rows: None,
                        max_rows: None,
                    })
                    .await
            })
        };
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        let started = std::time::Instant::now();
        client
            .cancel(&CancelParams {
                connection: "cancel".into(),
                statement: "slow".into(),
            })
            .await
            .unwrap();
        // An interrupted SLEEP returns 1 instead of failing: it says it was cancelled anyway.
        let error = running.await.unwrap().unwrap_err();
        assert_eq!(error.code, ErrorCode::Cancelled, "{error:?}");
        assert!(started.elapsed().as_secs() < 10);
        assert_eq!(
            single(&client, "cancel", "SELECT DATABASE()").await,
            Value::Text("information_schema".into())
        );
        assert_eq!(
            single(&client, "cancel", "SELECT 1").await,
            Value::Integer(1)
        );
    }
}
