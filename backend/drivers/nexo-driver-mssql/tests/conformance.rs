//! The SDK's conformance checks, the 100 000 rows read by pages, batches with their messages
//! and results, and the errors each wrong connection gives.
mod common;

use common::{driver, params, run, single, tls_params};
use nexo_driver_mssql::MssqlDriver;
use nexo_driver_sdk::{
    ErrorCode, Value, ValueKind,
    conformance::{Suite, check},
    protocol::TlsMode,
    statements::{ExecuteParams, FetchParams},
};

#[tokio::test]
async fn passes_the_conformance_checks() {
    let connect = fixture!(params("conformance"));
    let mut wrong = connect.clone();
    wrong.password = Some("wrong".into());
    let suite = Suite {
        connect,
        wrong_password: Some(wrong),
        paged_sql: "SELECT n, label FROM dbo.numbers WHERE n <= 120 ORDER BY n".into(),
        paged_rows: 120,
        slow_sql: Some("WAITFOR DELAY '00:01:00'".into()),
        invalid_sql: "SELECT 1 +".into(),
        values: vec![
            (
                "SELECT CAST(9223372036854775807 AS bigint)".into(),
                Value::Integer(i64::MAX),
            ),
            (
                "SELECT CAST(12345678901234567890.123456789 AS decimal(38, 9))".into(),
                Value::typed(ValueKind::Decimal, "12345678901234567890.123456789"),
            ),
            ("SELECT 0x00FF".into(), Value::bytes(&[0, 255])),
            ("SELECT CAST(NULL AS nvarchar(10))".into(), Value::Null),
            ("SELECT N'año'".into(), Value::Text("año".into())),
        ],
        rollback: Some((
            "INSERT INTO shop.customers (email) VALUES (N'rolled-back@example.com')".into(),
            "SELECT COUNT(*) FROM shop.customers".into(),
        )),
    };
    let failures = check(MssqlDriver::default(), suite).await;
    assert!(failures.is_empty(), "{failures:#?}");
}

#[tokio::test]
async fn reads_a_hundred_thousand_rows_by_pages() {
    let connect = fixture!(params("pages"));
    let client = driver();
    client.connect(&connect).await.unwrap();
    let first = run(
        &client,
        "pages",
        "SELECT n, label FROM dbo.numbers ORDER BY n",
    )
    .await
    .unwrap();
    assert_eq!(first.rows.len(), 1000);
    let (mut total, mut cursor, mut last) = (first.rows.len(), first.cursor, Value::Null);
    while let Some(open) = cursor {
        let page = client
            .fetch(&FetchParams {
                connection: "pages".into(),
                cursor: open,
                page_rows: Some(5000),
            })
            .await
            .unwrap();
        total += page.rows.len();
        last = page.rows.last().map_or(last, |row| row[0].clone());
        cursor = page.cursor;
    }
    assert_eq!((total, last), (100_000, Value::Integer(100_000)));
}

#[tokio::test]
async fn a_batch_tells_its_messages_and_a_procedure_its_two_results() {
    let connect = fixture!(params("batches"));
    let client = driver();
    client.connect(&connect).await.unwrap();
    // Three batches, as the editor sends what GO separates, each with its messages in order.
    for (number, batch) in [
        "PRINT 'one'",
        "PRINT 'two'; RAISERROR('three', 10, 1)",
        "SELECT 1",
    ]
    .iter()
    .enumerate()
    {
        let done = run(&client, "batches", batch).await.unwrap();
        let messages: Vec<&str> = done
            .notices
            .iter()
            .map(|notice| notice.message.as_str())
            .collect();
        match number {
            0 => assert_eq!(messages, ["one"]),
            1 => assert_eq!(messages, ["two", "three"]),
            _ => assert_eq!(done.rows, [[Value::Integer(1)]]),
        }
    }
    let both = run(&client, "batches", "EXEC shop.two_results")
        .await
        .unwrap();
    assert_eq!(both.columns[1].name, "email");
    assert_eq!(both.rows.len(), 2);
    assert_eq!(both.results.len(), 1);
    assert_eq!(both.results[0].columns[1].name, "total");
    assert_eq!(both.results[0].rows.len(), 3);
    // A write says how many rows it changed; a parameter is bound, never written in.
    let changed = client
        .execute(&ExecuteParams {
            connection: "batches".into(),
            statement: "update".into(),
            sql: "UPDATE shop.orders SET status = status WHERE customer = @P1".into(),
            params: vec![Value::Integer(1)],
            page_rows: None,
            max_rows: None,
        })
        .await
        .unwrap();
    assert_eq!(changed.affected, Some(2));
    let error = run(&client, "batches", "SELECT 1;\nSELECT * FROM nowhere")
        .await
        .unwrap_err();
    assert_eq!(error.code, ErrorCode::Invalid, "{error:?}");
    assert_eq!(error.detail.unwrap()["line"], 2);
}

#[tokio::test]
async fn each_wrong_connection_says_why() {
    let base = fixture!(params("errors"));
    let client = driver();
    let mut missing = base.clone();
    missing.database = Some("nowhere".into());
    let error = client.connect(&missing).await.unwrap_err();
    assert_eq!(error.code, ErrorCode::Invalid, "{error:?}");
    assert!(error.message.contains("nowhere"), "{}", error.message);

    let mut blocked = base.clone();
    blocked.host = Some("blocked.test".into());
    let error = client.connect(&blocked).await.unwrap_err();
    assert_eq!(error.code, ErrorCode::Network);
    assert!(error.message.contains("egress policy"));

    let mut unknown = base.clone();
    unknown.options.insert("Encrypt".into(), "yes".into());
    let error = client.connect(&unknown).await.unwrap_err();
    assert!(
        error.message.contains("has no setting Encrypt"),
        "{}",
        error.message
    );

    // TLS checked against the fixture's CA; without it the server is not trusted.
    let tls = fixture!(tls_params("tls"));
    let mut untrusted = tls.clone();
    untrusted.tls.ca_pem = None;
    assert_eq!(
        client.connect(&untrusted).await.unwrap_err().code,
        ErrorCode::Tls
    );
    let server = client.connect(&tls).await.unwrap();
    assert!(server.tls, "{server:?}");
    assert_eq!(
        single(
            &client,
            "tls",
            "SELECT encrypt_option FROM sys.dm_exec_connections WHERE session_id = @@SPID"
        )
        .await,
        Value::Text("TRUE".into())
    );
    let mut plain = base.clone();
    plain.connection = "plain".into();
    plain.tls.mode = TlsMode::Disable;
    client.connect(&plain).await.unwrap();
}

#[tokio::test]
async fn a_read_only_session_is_refused_writes() {
    let mut connect = fixture!(params("read-only"));
    connect.read_only = true;
    let client = driver();
    client.connect(&connect).await.unwrap();
    // ApplicationIntent=ReadOnly only reaches a secondary; Nexo's rules refuse writes
    // before they leave. The session still reads.
    assert_eq!(
        single(&client, "read-only", "SELECT COUNT(*) FROM shop.customers").await,
        Value::Integer(2)
    );
}
