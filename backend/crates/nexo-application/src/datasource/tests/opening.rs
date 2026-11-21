//! What a session runs as it opens, and opening it again when its connection closed (DB-25).
use super::*;
use crate::testing::datasources::FakeSources;

fn executed(sources: &FakeSources) -> Vec<String> {
    let executed = sources.executed.lock().unwrap();
    executed
        .iter()
        .map(|(_, request)| request.sql.clone())
        .collect()
}

#[tokio::test]
async fn a_session_opens_on_its_default_schema_and_runs_its_startup_queries() {
    let (application, _, sources) = with_sources(json!({
        "defaultSchema": "sales", "startupQueries": ["SET work_mem = '64MB'"],
        "keepAliveSeconds": 60, "idleMinutes": 5, "connectTimeoutSeconds": 20,
    }));
    connect(&application, "s1").await.unwrap();
    assert_eq!(
        executed(&sources),
        [r#"SET search_path TO "sales""#, "SET work_mem = '64MB'"]
    );
    let (_, connection) = sources.connected.lock().unwrap()[0].clone();
    assert_eq!(connection.idle, Some(std::time::Duration::from_secs(300)));
    assert_eq!(
        connection.connect_timeout,
        Some(std::time::Duration::from_secs(20))
    );
    let (every, query) = connection.keep_alive.unwrap();
    assert_eq!((every.as_secs(), query.as_str()), (60, "SELECT 1"));
}

#[tokio::test]
async fn a_startup_query_that_fails_keeps_the_session_closed_unless_it_may_fail() {
    let (application, _, sources) = with_sources(json!({"startupQueries": ["SELECT fail"]}));
    let error = message(connect(&application, "s1").await);
    assert!(
        error.starts_with("The startup query «SELECT fail» failed"),
        "{error}"
    );
    // The password the fake driver says is kept out.
    assert!(!error.contains("secret-of"), "{error}");
    assert_eq!(*sources.disconnected.lock().unwrap(), ["s1"]);
    assert!(message(run(&application, "SELECT 1", json!({})).await).contains("not open"));

    let (application, _, _) = with_sources(json!({
        "startupQueries": ["SELECT fail"], "ignoreStartupErrors": true}));
    let opened = connect(&application, "s1").await.unwrap();
    assert_eq!(opened["startup"][0]["sql"], "SELECT fail");
    assert!(!opened.to_string().contains("secret-of"));
    run(&application, "SELECT 1", json!({})).await.unwrap();
}

#[tokio::test]
async fn a_closed_session_opens_again_and_reruns_only_what_reads() {
    let (application, _, sources) = with_sources(json!({"startupQueries": ["SET a = 1"]}));
    connect(&application, "s1").await.unwrap();
    // A read: it runs again on the new connection, which ran its startup query again.
    *sources.closing.lock().unwrap() = 1;
    let tree = application
        .execute(Operation::DbTree, json!({"session": "s1", "path": []}))
        .await
        .unwrap();
    assert_eq!(tree["reconnected"], true);
    assert_eq!(sources.connected.lock().unwrap().len(), 2);
    assert_eq!(executed(&sources), ["SET a = 1", "SET a = 1"]);
    *sources.closing.lock().unwrap() = 1;
    let read = run(&application, "SELECT 2", json!({})).await.unwrap();
    assert_eq!(read["reconnected"], true);

    // In manual commits, a write is never run again, and the transaction is said lost.
    application
        .execute(
            Operation::DbTransaction,
            json!({"session": "s1", "action": "manual"}),
        )
        .await
        .unwrap();
    run(&application, "UPDATE t SET a = 1 WHERE id = 1", json!({}))
        .await
        .unwrap();
    *sources.closing.lock().unwrap() = 1;
    let error = run(&application, "UPDATE t SET a = 2 WHERE id = 1", json!({}))
        .await
        .unwrap_err();
    let Error::Database {
        code,
        message,
        detail,
    } = error
    else {
        panic!("{error}");
    };
    assert_eq!(code, "reconnected");
    assert!(
        message.contains("ran nothing. Its open transaction was lost."),
        "{message}"
    );
    assert_eq!(detail.unwrap()["transactionLost"], true);
    let writes = executed(&sources);
    assert_eq!(writes.iter().filter(|sql| sql.contains("a = 2")).count(), 1);
    // Manual commits stay manual on the new connection.
    assert_eq!(*sources.transactions.lock().unwrap(), ["manual", "manual"]);
}
