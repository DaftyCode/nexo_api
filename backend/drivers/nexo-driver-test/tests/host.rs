//! The host of the driver processes, against the test driver's real executable: what it
//! asks, what it answers the driver, and what it keeps out of logs and errors.
mod common;

use common::{connection, fixture, fixture_with, statement};
use nexo_driver_sdk::{
    ErrorCode, Value, methods,
    protocol::{ObjectParams, TreeNodes},
    statements::{CancelParams, ExecuteResult, FetchParams, Page},
};
use std::time::Duration;

#[tokio::test]
async fn runs_a_statement_by_pages_and_cancels_another() {
    let fixture = fixture();
    let host = &fixture.host;
    let hello = host.hello("test").await.unwrap();
    assert_eq!(hello.driver.id, "test");
    let server = host
        .connect("test", connection("main"), Vec::new())
        .await
        .unwrap();
    assert_eq!(server.server_version, "1.0");
    assert_eq!(host.running().await, ["test"]);

    let top = ObjectParams {
        connection: "main".into(),
        path: Vec::new(),
    };
    let tree: TreeNodes = host.call("main", methods::TREE, &top).await.unwrap();
    assert_eq!(tree.nodes.len(), 2);

    let first: ExecuteResult = host
        .call(
            "main",
            methods::EXECUTE,
            &statement("main", "s1", "select numbers 75"),
        )
        .await
        .unwrap();
    assert_eq!(first.rows.len(), 50);
    assert_eq!(
        first.rows[0],
        [Value::Integer(1), Value::Text("row 1".into())]
    );
    let next = FetchParams {
        connection: "main".into(),
        cursor: first.cursor.expect("more rows leave a cursor"),
        page_rows: Some(50),
    };
    let second: Page = host.call("main", methods::FETCH, &next).await.unwrap();
    assert_eq!(second.rows.len(), 25);
    assert_eq!(second.cursor, None);

    // A slow statement does not hold the others of its process, and can be cancelled.
    let slow = tokio::spawn({
        let host = host.clone();
        async move {
            let slow = statement("main", "slow", "sleep 60000");
            host.call::<_, ExecuteResult>("main", methods::EXECUTE, &slow)
                .await
        }
    });
    tokio::time::sleep(Duration::from_millis(200)).await;
    let quick: ExecuteResult = host
        .call(
            "main",
            methods::EXECUTE,
            &statement("main", "s2", "count people"),
        )
        .await
        .unwrap();
    assert_eq!(quick.rows, [[Value::Integer(2)]]);
    let cancelling = CancelParams {
        connection: "main".into(),
        statement: "slow".into(),
    };
    host.call::<_, ()>("main", methods::CANCEL, &cancelling)
        .await
        .unwrap();
    assert_eq!(slow.await.unwrap().unwrap_err().code, ErrorCode::Cancelled);

    host.disconnect("main").await.unwrap();
    let closed = host
        .call::<_, ExecuteResult>(
            "main",
            methods::EXECUTE,
            &statement("main", "s3", "count people"),
        )
        .await;
    assert_eq!(closed.unwrap_err().code, ErrorCode::Invalid);
    host.shutdown().await;
}

#[tokio::test]
async fn a_driver_that_dies_fails_its_requests_and_starts_again() {
    let fixture = fixture();
    let host = &fixture.host;
    host.connect("test", connection("main"), Vec::new())
        .await
        .unwrap();
    let dying = host
        .call::<_, ExecuteResult>("main", methods::EXECUTE, &statement("main", "s1", "crash"))
        .await;
    assert_eq!(dying.unwrap_err().code, ErrorCode::Closed);
    // Its connection went with it, and the error says what to do.
    let after = host
        .call::<_, ExecuteResult>(
            "main",
            methods::EXECUTE,
            &statement("main", "s2", "count people"),
        )
        .await
        .unwrap_err();
    assert_eq!(after.code, ErrorCode::Closed);
    assert!(after.message.contains("Connect again"), "{}", after.message);
    assert!(host.running().await.is_empty());
    // The next connection starts the driver again, with the same name free.
    host.connect("test", connection("main"), Vec::new())
        .await
        .unwrap();
    let count: ExecuteResult = host
        .call(
            "main",
            methods::EXECUTE,
            &statement("main", "s3", "count people"),
        )
        .await
        .unwrap();
    assert_eq!(count.rows, [[Value::Integer(2)]]);
    host.shutdown().await;
}

#[tokio::test]
async fn refuses_what_is_not_a_module_or_an_open_connection() {
    let fixture = fixture();
    let host = &fixture.host;
    let missing = host.hello("no-such-engine").await.unwrap_err();
    assert_eq!(missing.code, ErrorCode::Unsupported);
    assert_eq!(
        missing.message,
        "The no-such-engine module is not installed"
    );
    for name in ["", "../test", "Test", "test.exe"] {
        assert_eq!(
            host.hello(name).await.unwrap_err().code,
            ErrorCode::Invalid,
            "{name}"
        );
    }
    let unknown = host
        .call::<_, ExecuteResult>(
            "nobody",
            methods::EXECUTE,
            &statement("nobody", "s", "count people"),
        )
        .await;
    assert_eq!(unknown.unwrap_err().code, ErrorCode::Invalid);

    host.connect("test", connection("main"), Vec::new())
        .await
        .unwrap();
    let twice = host
        .connect("test", connection("main"), Vec::new())
        .await
        .unwrap_err();
    assert_eq!(twice.code, ErrorCode::Invalid);
    // The first one is still there.
    assert!(host.disconnect("main").await.is_ok());
    // A wrong password leaves nothing open either.
    let mut wrong = connection("main");
    wrong.password = Some("wrong".into());
    assert_eq!(
        host.connect("test", wrong, Vec::new())
            .await
            .unwrap_err()
            .code,
        ErrorCode::Auth
    );
    host.connect("test", connection("main"), Vec::new())
        .await
        .unwrap();
    host.shutdown().await;
}

#[tokio::test]
async fn stops_waiting_for_a_driver_that_does_not_answer() {
    let fixture = fixture_with(|config| config.request_timeout = Duration::from_millis(300));
    let host = &fixture.host;
    host.connect("test", connection("main"), Vec::new())
        .await
        .unwrap();
    let late = host
        .call::<_, ExecuteResult>(
            "main",
            methods::EXECUTE,
            &statement("main", "s1", "sleep 60000"),
        )
        .await;
    assert_eq!(late.unwrap_err().code, ErrorCode::Timeout);
    // A caller that asks for more time gets it; the driver is still there.
    let patient: ExecuteResult = host
        .call_within(
            "main",
            methods::EXECUTE,
            &statement("main", "s2", "sleep 600"),
            Some(Duration::from_secs(10)),
        )
        .await
        .unwrap();
    assert!(patient.rows.is_empty());
    host.shutdown().await;
}
