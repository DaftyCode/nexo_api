//! The SDK's conformance checks against MySQL and MariaDB, the 100 000 rows read by pages, a
//! procedure's two results, writes with their counts, ids and warnings, and the errors each
//! wrong connection gives.
mod common;

use common::{driver, mariadb, params, run, single, tls_params};
use nexo_driver_mysql::MysqlDriver;
use nexo_driver_sdk::{
    ErrorCode, Value, ValueKind,
    conformance::{Suite, check},
    protocol::{ConnectParams, TlsMode},
    statements::{ExecuteParams, FetchParams},
};

fn suite(connect: ConnectParams) -> Suite {
    let mut wrong = connect.clone();
    wrong.password = Some("wrong".into());
    Suite {
        connect,
        wrong_password: Some(wrong),
        paged_sql: "SELECT n, label FROM numbers WHERE n <= 120 ORDER BY n".into(),
        paged_rows: 120,
        slow_sql: Some("SELECT SLEEP(60)".into()),
        invalid_sql: "SELECT 1 +".into(),
        values: vec![
            (
                "SELECT CAST(18446744073709551615 AS UNSIGNED)".into(),
                Value::typed(ValueKind::Decimal, "18446744073709551615"),
            ),
            (
                "SELECT CAST(12345678901234567890.123456789 AS DECIMAL(38, 9))".into(),
                Value::typed(ValueKind::Decimal, "12345678901234567890.123456789"),
            ),
            ("SELECT X'00FF'".into(), Value::bytes(&[0, 255])),
            ("SELECT CAST(NULL AS CHAR)".into(), Value::Null),
            ("SELECT 'año'".into(), Value::Text("año".into())),
        ],
        rollback: Some((
            "INSERT INTO customers (email) VALUES ('rolled-back@example.com')".into(),
            "SELECT COUNT(*) FROM customers".into(),
        )),
    }
}

#[tokio::test]
async fn mysql_passes_the_conformance_checks() {
    let connect = fixture!(params("conformance"));
    let failures = check(MysqlDriver::default(), suite(connect)).await;
    assert!(failures.is_empty(), "{failures:#?}");
}

#[tokio::test]
async fn mariadb_passes_the_conformance_checks() {
    let connect = fixture!(mariadb("conformance"));
    let failures = check(MysqlDriver::default(), suite(connect)).await;
    assert!(failures.is_empty(), "{failures:#?}");
}

#[tokio::test]
async fn reads_a_hundred_thousand_rows_by_pages() {
    let connect = fixture!(params("pages"));
    let client = driver();
    client.connect(&connect).await.unwrap();
    let first = run(&client, "pages", "SELECT n, label FROM numbers ORDER BY n")
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
    // A result left open ends when the next request comes, and that request is answered.
    let open = run(&client, "pages", "SELECT n FROM numbers")
        .await
        .unwrap();
    assert!(open.cursor.is_some());
    assert_eq!(
        single(&client, "pages", "SELECT 7").await,
        Value::Integer(7)
    );
}

#[tokio::test]
async fn a_procedure_gives_its_two_results_and_a_write_its_count_and_id() {
    for connect in [params("results"), mariadb("results")] {
        let connect = fixture!(connect);
        let client = driver();
        client.connect(&connect).await.unwrap();
        let both = run(&client, "results", "CALL two_results()").await.unwrap();
        assert_eq!(both.columns[0].name, "first");
        assert_eq!(both.rows, [[Value::Integer(1)]]);
        assert_eq!(both.results.len(), 1, "{:?}", both.results);
        assert_eq!(
            both.results[0].rows,
            [[Value::Text("two".into()), Value::Integer(2)]]
        );
        // A write says how many rows it changed; a parameter is bound, never written in.
        let changed = client
            .execute(&ExecuteParams {
                connection: "results".into(),
                statement: "update".into(),
                sql: "UPDATE orders SET status = status WHERE customer = ?".into(),
                params: vec![Value::Integer(1)],
                page_rows: None,
                max_rows: None,
            })
            .await
            .unwrap();
        assert_eq!(changed.affected, Some(2), "the rows it matched");
        let inserted = run(
            &client,
            "results",
            "INSERT INTO customers (email) VALUES (CONCAT('id-', UUID()))",
        )
        .await
        .unwrap();
        assert_eq!(inserted.affected, Some(1));
        assert!(
            inserted
                .notices
                .iter()
                .any(|notice| notice.message.starts_with("Last inserted id")),
            "{:?}",
            inserted.notices
        );
        run(
            &client,
            "results",
            "DELETE FROM customers WHERE email LIKE 'id-%'",
        )
        .await
        .unwrap();
        // The warnings of a statement come with it.
        let warned = run(&client, "results", "SELECT CAST('x' AS SIGNED)")
            .await
            .unwrap();
        assert!(
            warned
                .notices
                .iter()
                .any(|notice| notice.severity == "warning"),
            "{:?}",
            warned.notices
        );
        // A syntax error says where it is.
        let error = run(&client, "results", "SELECT 1,\n  2 FORM t")
            .await
            .unwrap_err();
        assert_eq!(error.code, ErrorCode::Syntax, "{error:?}");
        let detail = error.detail.unwrap();
        assert_eq!(
            (detail["line"].clone(), detail["column"].clone()),
            (2.into(), 10.into())
        );
    }
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
    unknown.options.insert("sslmode".into(), "require".into());
    let error = client.connect(&unknown).await.unwrap_err();
    assert!(
        error.message.contains("has no setting sslmode"),
        "{}",
        error.message
    );

    // TLS checked against the fixture's CA; without it the server is not trusted.
    let tls = fixture!(tls_params("tls"));
    let mut untrusted = tls.clone();
    untrusted.tls.ca_pem = None;
    untrusted.connection = "untrusted".into();
    assert_eq!(
        client.connect(&untrusted).await.unwrap_err().code,
        ErrorCode::Tls
    );
    let server = client.connect(&tls).await.unwrap();
    assert!(server.tls, "{server:?}");
    assert_eq!(server.product.as_deref(), Some("MySQL"));
    let mut plain = base.clone();
    plain.connection = "plain".into();
    plain.tls.mode = TlsMode::Prefer;
    client.connect(&plain).await.unwrap();
    // The settings of a session: its time zone and character set.
    let mut set = base.clone();
    set.connection = "settings".into();
    set.options.insert("time_zone".into(), "+02:00".into());
    set.options.insert("charset".into(), "utf8mb4".into());
    client.connect(&set).await.unwrap();
    assert_eq!(
        single(&client, "settings", "SELECT @@session.time_zone").await,
        Value::Text("+02:00".into())
    );
}

#[tokio::test]
async fn a_read_only_session_is_refused_writes() {
    for connect in [params("read-only"), mariadb("read-only")] {
        let mut connect = fixture!(connect);
        connect.read_only = true;
        let client = driver();
        client.connect(&connect).await.unwrap();
        assert_eq!(
            single(&client, "read-only", "SELECT COUNT(*) FROM customers").await,
            Value::Integer(2)
        );
        let error = run(&client, "read-only", "UPDATE customers SET name = name")
            .await
            .unwrap_err();
        assert_eq!(error.code, ErrorCode::Permission, "{error:?}");
    }
}
