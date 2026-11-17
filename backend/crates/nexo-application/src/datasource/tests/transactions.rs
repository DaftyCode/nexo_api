//! The log of a session's transaction, the list of open ones and keeping them from closing.
use super::*;

async fn transaction(application: &Application, action: &str) -> Value {
    application
        .execute(
            Operation::DbTransaction,
            json!({"session": "s1", "action": action}),
        )
        .await
        .unwrap()
}
async fn open(application: &Application) -> Vec<Value> {
    let answer = application
        .execute(Operation::DbTransactions, json!({"workspace": "local"}))
        .await
        .unwrap();
    answer["sessions"].as_array().unwrap().clone()
}

#[tokio::test]
async fn manual_commit_logs_each_statement_until_the_transaction_ends() {
    let (application, _, sources) = with_sources(json!({}));
    connect(&application, "s1").await.unwrap();
    run(
        &application,
        "update orders set a = 1 where id = 1",
        json!({}),
    )
    .await
    .unwrap();
    assert!(
        open(&application).await.is_empty(),
        "auto-commit logs nothing"
    );
    let manual = transaction(&application, "manual").await;
    assert_eq!(
        (
            manual["autoCommit"].as_bool(),
            manual["statements"].as_u64()
        ),
        (Some(false), Some(0))
    );
    run(
        &application,
        "update orders set a = 2 where id = 1",
        json!({}),
    )
    .await
    .unwrap();
    // The password the connection used never comes back, not even in the log.
    run(&application, "select 'secret-of-db-password:c1'", json!({}))
        .await
        .unwrap();
    let sessions = open(&application).await;
    assert_eq!(sessions.len(), 1);
    assert_eq!(sessions[0]["session"], "s1");
    assert_eq!(sessions[0]["connection"], "c1");
    assert_eq!(sessions[0]["statements"], 2);
    let log = sessions[0]["log"].as_array().unwrap();
    assert_eq!(log[0]["sql"], "update orders set a = 2 where id = 1");
    assert!(!sessions[0].to_string().contains("secret-of"));
    assert_eq!(
        sources.held.lock().unwrap().last(),
        Some(&("s1".into(), true))
    );
    // A commit (here, the driver saying nothing is open) empties the log and lets it close.
    let committed = transaction(&application, "commit").await;
    assert_eq!(committed["statements"], 0);
    assert!(open(&application).await.is_empty());
    assert_eq!(
        sources.held.lock().unwrap().last(),
        Some(&("s1".into(), false))
    );
    let refused = application
        .execute(
            Operation::DbTransaction,
            json!({"session": "s1", "action": "savepoint"}),
        )
        .await;
    assert!(message(refused).contains("Unknown transaction action"));
}
