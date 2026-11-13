//! The SDK's conformance checks, the 100 000 rows read by pages, and the errors each wrong
//! connection gives.
mod common;

use common::{driver, params, run, tls_params};
use nexo_driver_postgres::PostgresDriver;
use nexo_driver_sdk::{
    ErrorCode, Value, ValueKind,
    conformance::{Suite, check},
    protocol::TlsMode,
    statements::FetchParams,
};

#[tokio::test]
async fn passes_the_conformance_checks() {
    let connect = fixture!(params("conformance", None));
    let mut wrong = connect.clone();
    wrong.password = Some("wrong".into());
    let suite = Suite {
        connect,
        wrong_password: Some(wrong),
        paged_sql: "SELECT n, label FROM numbers WHERE n <= 120 ORDER BY n".into(),
        paged_rows: 120,
        slow_sql: Some("SELECT pg_sleep(60)".into()),
        invalid_sql: "SELEC 1".into(),
        values: vec![
            (
                "SELECT 9223372036854775807::bigint".into(),
                Value::Integer(i64::MAX),
            ),
            (
                "SELECT 12345678901234567890.123456789::numeric".into(),
                Value::typed(ValueKind::Decimal, "12345678901234567890.123456789"),
            ),
            ("SELECT '\\x00ff'::bytea".into(), Value::bytes(&[0, 255])),
            ("SELECT NULL::text".into(), Value::Null),
            ("SELECT 'año'::text".into(), Value::Text("año".into())),
        ],
        rollback: Some((
            "INSERT INTO shop.customers (email) VALUES ('rolled-back@example.com')".into(),
            "SELECT count(*) FROM shop.customers".into(),
        )),
    };
    let failures = check(PostgresDriver::default(), suite).await;
    assert!(failures.is_empty(), "{failures:#?}");
}

#[tokio::test]
async fn reads_a_hundred_thousand_rows_by_pages() {
    let connect = fixture!(params("pages", None));
    let client = driver();
    client.connect(&connect).await.unwrap();
    let first = run(&client, "pages", "SELECT n, label FROM numbers ORDER BY n")
        .await
        .unwrap();
    assert_eq!(first.rows.len(), 1000);
    assert_eq!(first.columns[0].origin.as_ref().unwrap().column, "n");
    assert!(first.columns[0].key);
    let (mut total, mut cursor, mut pages, mut last) =
        (first.rows.len(), first.cursor, 1, Value::Null);
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
        pages += 1;
        last = page.rows.last().map_or(last, |row| row[0].clone());
        cursor = page.cursor;
    }
    assert_eq!((total, pages, last), (100_000, 21, Value::Integer(100_000)));
}

#[tokio::test]
async fn each_wrong_connection_says_why() {
    let base = fixture!(params("errors", None));
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

    let mut closed = base.clone();
    closed.port = Some(1);
    assert_eq!(
        client.connect(&closed).await.unwrap_err().code,
        ErrorCode::Network
    );

    let mut unknown = base.clone();
    unknown
        .options
        .insert("sslcert".into(), "/etc/passwd".into());
    let error = client.connect(&unknown).await.unwrap_err();
    assert!(
        error.message.contains("has no setting sslcert"),
        "{}",
        error.message
    );

    // TLS: without the CA the server is not trusted; with it and the client certificate, it is.
    let tls = fixture!(tls_params("tls"));
    let mut untrusted = tls.clone();
    untrusted.tls.ca_pem = None;
    assert_eq!(
        client.connect(&untrusted).await.unwrap_err().code,
        ErrorCode::Tls
    );
    let mut plain = tls.clone();
    plain.tls.mode = TlsMode::Disable;
    assert!(client.connect(&plain).await.is_err());
    let server = client.connect(&tls).await.unwrap();
    assert!(server.tls, "{server:?}");
    assert_eq!(
        common::single(
            &client,
            "tls",
            "SELECT ssl::text FROM pg_stat_ssl WHERE pid = pg_backend_pid()"
        )
        .await,
        Value::Text("true".into())
    );
}

#[tokio::test]
async fn a_read_only_session_is_refused_writes_by_the_server() {
    let mut connect = fixture!(params("read-only", None));
    connect.read_only = true;
    let client = driver();
    client.connect(&connect).await.unwrap();
    // A read that writes: only the server can tell.
    let error = run(
        &client,
        "read-only",
        "SELECT nextval('shop.invoice_numbers')",
    )
    .await
    .unwrap_err();
    assert_eq!(error.code, ErrorCode::Permission, "{error:?}");
}
