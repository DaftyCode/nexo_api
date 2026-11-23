//! The Ignite module against the fixture's Ignite 3 nodes (`tools/nosql-fixture.sh`): 100 000
//! rows by pages and a transaction rolled back, a query cancelled from the list of running
//! ones, TLS with authentication, and an address the egress policy refuses.
mod common;

use common::{Host, SLOW, driver, driver_with, params, run, secure};
use nexo_driver_sdk::{
    ErrorCode, Value,
    admin::{AdminParams, KillMode, KillParams},
    protocol::TlsMode,
    statements::{CursorParams, FetchParams, TransactionAction, TransactionParams},
};

#[tokio::test]
async fn a_hundred_thousand_rows_come_by_pages_and_a_transaction_is_rolled_back() {
    let connect = fixture!(params("pages"));
    let client = driver();
    client.connect(&connect).await.unwrap();
    let mut all = run("pages", "SELECT ID, NAME FROM SHOP.ITEMS ORDER BY ID");
    all.page_rows = Some(500);
    let first = client.execute(&all).await.unwrap();
    assert_eq!(first.rows.len(), 500);
    let fetch = FetchParams {
        connection: "pages".into(),
        cursor: first.cursor.unwrap(),
        page_rows: Some(2000),
    };
    let second = client.fetch(&fetch).await.unwrap();
    assert_eq!(second.rows.len(), 2000, "pages of the server joined");
    assert_eq!(second.rows[0][0], Value::Integer(501));
    let close = CursorParams {
        connection: "pages".into(),
        cursor: second.cursor.unwrap(),
    };
    client.close(&close).await.unwrap();
    let transaction = |action| TransactionParams {
        connection: "pages".into(),
        action,
        isolation: None,
    };
    let manual = client
        .transaction(&transaction(TransactionAction::Manual))
        .await;
    assert!(!manual.unwrap().auto_commit);
    let count = "SELECT COUNT(*) FROM SHOP.ITEMS";
    client
        .execute(&run("pages", "DELETE FROM SHOP.ITEMS WHERE ID <= 10"))
        .await
        .unwrap();
    let inside = client.execute(&run("pages", count)).await.unwrap();
    assert_eq!(inside.rows[0][0], Value::Integer(99_990));
    let state = client
        .transaction(&transaction(TransactionAction::Rollback))
        .await;
    assert!(!state.unwrap().open);
    client
        .transaction(&transaction(TransactionAction::Auto))
        .await
        .unwrap();
    let after = client.execute(&run("pages", count)).await.unwrap();
    assert_eq!(after.rows[0][0], Value::Integer(100_000));
}

#[tokio::test]
async fn a_running_query_is_listed_and_cancelled() {
    let connect = fixture!(params("busy"));
    let client = driver();
    client.connect(&connect).await.unwrap();
    let mut watcher = connect.clone();
    watcher.connection = "watcher".into();
    client.connect(&watcher).await.unwrap();
    let running = {
        let client = client.clone();
        tokio::spawn(async move { client.execute(&run("busy", SLOW)).await })
    };
    let asking = AdminParams {
        connection: "watcher".into(),
        statement: "admin".into(),
    };
    let mut found = None;
    for _ in 0..50 {
        let sessions = client.sessions(&asking).await.unwrap().sessions;
        assert!(sessions.iter().any(|session| session.own));
        found = sessions.into_iter().find(|session| {
            session
                .sql
                .as_deref()
                .is_some_and(|sql| sql.contains("SYSTEM_RANGE"))
        });
        if found.is_some() {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
    let session = found.expect("the slow query is listed");
    let kill = KillParams {
        connection: "watcher".into(),
        statement: "kill".into(),
        session: session.id,
        mode: KillMode::Cancel,
    };
    assert!(client.kill(&kill).await.unwrap().done);
    let outcome = running.await.unwrap();
    assert_eq!(outcome.unwrap_err().code, ErrorCode::Cancelled);
}

#[tokio::test]
async fn tls_and_authentication_are_checked() {
    let connect = fixture!(secure("secure"));
    let client = driver();
    let info = client.connect(&connect).await.unwrap();
    assert!(info.tls);
    assert!(info.server_version.starts_with('3'), "{info:?}");
    let one = client.execute(&run("secure", "SELECT 1")).await.unwrap();
    assert_eq!(one.rows[0][0], Value::Integer(1));
    let mut wrong = connect.clone();
    wrong.connection = "wrong".into();
    wrong.password = Some("not-the-password".into());
    assert_eq!(
        client.connect(&wrong).await.unwrap_err().code,
        ErrorCode::Auth
    );
    let mut checked = connect.clone();
    checked.connection = "checked".into();
    checked.tls.mode = TlsMode::Verify;
    let refused = client.connect(&checked).await.unwrap_err();
    assert_eq!(refused.code, ErrorCode::Tls, "{refused:?}");
    let mut plain = connect.clone();
    plain.connection = "plain".into();
    plain.tls.mode = TlsMode::Disable;
    assert!(client.connect(&plain).await.is_err());
}

#[tokio::test]
async fn an_address_the_policy_refuses_is_never_connected() {
    let connect = fixture!(params("refused"));
    let host = Host::default();
    let name = connect.host.clone().unwrap();
    host.refused.lock().unwrap().push(name.clone());
    let client = driver_with(host.clone());
    let refused = client.connect(&connect).await.unwrap_err();
    assert_eq!(refused.code, ErrorCode::Network);
    assert_eq!(*host.asked.lock().unwrap(), [name]);
}
