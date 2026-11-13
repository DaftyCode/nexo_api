//! The SDK's conformance checks, run against the driver in memory: they must pass for a
//! driver that does everything right, so a real driver's failures are its own.
use nexo_driver_sdk::{
    Value, ValueKind,
    conformance::{Suite, check},
    protocol::ConnectParams,
};
use nexo_driver_test::TestDriver;

fn connection(password: &str) -> ConnectParams {
    ConnectParams {
        connection: "conformance".into(),
        user: Some("ana".into()),
        password: Some(password.into()),
        ..ConnectParams::default()
    }
}

fn suite() -> Suite {
    Suite {
        connect: connection("secret"),
        wrong_password: Some(connection("wrong")),
        paged_sql: "select numbers 120".into(),
        paged_rows: 120,
        slow_sql: Some("sleep 60000".into()),
        invalid_sql: "nonsense".into(),
        values: vec![
            ("select value big".into(), Value::Integer(i64::MAX)),
            (
                "select value decimal".into(),
                Value::typed(ValueKind::Decimal, "12345678901234567890.5"),
            ),
            ("select value bytes".into(), Value::bytes(&[0, 1, 254, 255])),
            ("select value null".into(), Value::Null),
            ("select value text".into(), Value::Text("año".into())),
        ],
        rollback: Some(("insert person Linus".into(), "count people".into())),
    }
}

#[tokio::test]
async fn a_correct_driver_passes_every_check() {
    let failures = check(TestDriver::default(), suite()).await;
    assert!(failures.is_empty(), "{failures:#?}");
}

#[tokio::test]
async fn the_checks_notice_what_is_wrong() {
    // The same driver, asked for things it does not do.
    let wrong = Suite {
        paged_rows: 121,
        invalid_sql: "select people".into(),
        values: vec![("select value big".into(), Value::Integer(1))],
        ..suite()
    };
    let failures = check(TestDriver::default(), wrong).await;
    assert_eq!(failures.len(), 3, "{failures:#?}");
    assert!(
        failures[0].starts_with("every row is read once"),
        "{failures:#?}"
    );
    assert!(
        failures[1].starts_with("an invalid statement"),
        "{failures:#?}"
    );
    assert!(failures[2].starts_with("the value of"), "{failures:#?}");
}
