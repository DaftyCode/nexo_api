//! What the driver says of itself and what it checks before reaching a node.
use super::*;
use nexo_driver_sdk::{ErrorCode, statements::TransactionAction};
use std::collections::BTreeMap;

#[test]
fn the_driver_says_what_it_can_do() {
    let hello = IgniteDriver::default().hello();
    assert_eq!(hello.driver.id, "ignite");
    assert!(hello.capabilities.transactions && hello.capabilities.cancel);
    assert!(!hello.capabilities.schemas);
    assert_eq!(hello.capabilities.kill, [KillMode::Cancel]);
    assert!(
        hello
            .capabilities
            .methods
            .contains(&methods::SESSIONS.to_owned())
    );
    assert!(
        !hello
            .capabilities
            .methods
            .contains(&methods::LOCKS.to_owned())
    );
    assert_eq!(hello.dialect.quote_open, "\"");
}

#[test]
fn a_session_takes_only_a_time_zone() {
    let with = |pairs: &[(&str, &str)]| ConnectParams {
        options: pairs
            .iter()
            .map(|(name, value)| ((*name).to_owned(), (*value).to_owned()))
            .collect::<BTreeMap<_, _>>(),
        ..ConnectParams::default()
    };
    assert_eq!(time_zone(&with(&[])).unwrap(), "UTC");
    assert_eq!(
        time_zone(&with(&[("timeZone", " Europe/Madrid ")])).unwrap(),
        "Europe/Madrid"
    );
    assert_eq!(
        time_zone(&with(&[("timeZone", "+02:00")])).unwrap(),
        "+02:00"
    );
    assert!(time_zone(&with(&[("timeZone", "x'; DROP")])).is_err());
    assert!(time_zone(&with(&[("schema", "PUBLIC")])).is_err());
}

#[test]
fn a_plan_is_named_by_its_first_line() {
    let plan = statements::plan("\n  Exchange\n    distribution: single\n".into());
    assert_eq!(plan.nodes.len(), 1);
    assert_eq!(plan.nodes[0].operation, "Exchange");
    assert_eq!(plan.format, "text");
    assert!(statements::plan(String::new()).nodes.is_empty());
}

#[tokio::test]
async fn nothing_runs_on_a_connection_that_is_not_open() {
    let driver = IgniteDriver::default();
    let object = ObjectParams {
        connection: "none".into(),
        path: Vec::new(),
    };
    assert_eq!(
        driver.tree(object.clone()).await.unwrap_err().code,
        ErrorCode::Invalid
    );
    assert!(driver.describe(object.clone()).await.is_err());
    assert!(driver.ddl(object).await.is_err());
    let cursor = CursorParams {
        connection: "none".into(),
        cursor: "c1".into(),
    };
    assert!(driver.close(cursor).await.is_err());
    assert!(driver.disconnect("none").await.is_err());
    let transaction = TransactionParams {
        connection: "none".into(),
        action: TransactionAction::Status,
        isolation: Some("read committed".into()),
    };
    let refused = driver.transaction(transaction).await.unwrap_err();
    assert_eq!(refused.code, ErrorCode::Unsupported);
    let cancel = CancelParams {
        connection: "none".into(),
        statement: "s".into(),
    };
    assert!(driver.cancel(cancel).await.is_err());
}
