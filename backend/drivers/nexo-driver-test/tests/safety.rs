//! What the host keeps away from a driver and from what a driver says: the secrets of its
//! connections in logs and errors, and the destinations the egress policy does not allow.
mod common;

use common::{connection, fixture, statement};
use nexo_domain::hosts::AllowedHosts;
use nexo_driver_sdk::{ErrorCode, methods, statements::ExecuteResult};

#[tokio::test]
async fn secrets_stay_out_of_the_log_and_of_errors() {
    let fixture = fixture();
    let host = &fixture.host;
    let mut leaking = connection("main");
    leaking.options.insert("leak".into(), "log".into());
    host.connect("test", leaking, Vec::new()).await.unwrap();
    host.call::<_, ExecuteResult>(
        "main",
        methods::EXECUTE,
        &statement(
            "main",
            "s1",
            "stderr the password is secret, said the driver",
        ),
    )
    .await
    .unwrap();
    common::eventually("two log lines", async || {
        fixture.log.lock().unwrap().len() >= 2
    })
    .await;
    let log = fixture.log.lock().unwrap().join("\n");
    assert!(!log.contains("secret"), "{log}");
    assert!(
        log.contains("test info connecting with password [REDACTED]"),
        "{log}"
    );
    assert!(
        log.contains("the password is [REDACTED], said the driver"),
        "{log}"
    );

    let mut refused = connection("other");
    refused.password = Some("tr0ub4dor&3".into());
    refused.options.insert("leak".into(), "error".into());
    let error = host.connect("test", refused, Vec::new()).await.unwrap_err();
    assert_eq!(error.code, ErrorCode::Auth);
    assert_eq!(error.message, "The password [REDACTED] was refused");
    assert_eq!(error.detail.unwrap()["password"], "[REDACTED]");
    host.shutdown().await;
}

#[tokio::test]
async fn a_driver_connects_only_where_the_host_allows() {
    let fixture = fixture();
    let host = &fixture.host;
    let to = |name: &str, server: &str| {
        let mut params = connection(name);
        params.host = Some(server.into());
        params.port = Some(5432);
        params
    };
    host.connect("test", to("allowed", "db.example.com"), Vec::new())
        .await
        .unwrap();

    let error = host
        .connect("test", to("blocked", "private.example.com"), Vec::new())
        .await;
    let error = error.unwrap_err();
    assert_eq!(error.code, ErrorCode::Network);
    assert!(
        error.message.contains("blocked by the egress policy"),
        "{}",
        error.message
    );

    // A secret limited to other domains: refused before the policy is even asked.
    let limited = vec![(
        "db-password:1".to_owned(),
        AllowedHosts::parse(&["*.internal.test"]).unwrap(),
    )];
    let error = host
        .connect("test", to("limited", "db.example.com"), limited.clone())
        .await;
    let error = error.unwrap_err();
    assert_eq!(error.code, ErrorCode::Network);
    assert!(error.message.contains("db-password:1"), "{}", error.message);
    host.connect("test", to("within", "db.internal.test"), limited)
        .await
        .unwrap();

    let asked = fixture.policy.asked.lock().unwrap().clone();
    let asked: Vec<&str> = asked.iter().map(|(name, _)| name.as_str()).collect();
    assert_eq!(
        asked,
        ["db.example.com", "private.example.com", "db.internal.test"]
    );
    // Only the two that were allowed are open.
    assert!(host.disconnect("allowed").await.is_ok());
    assert!(host.disconnect("within").await.is_ok());
    assert_eq!(
        host.disconnect("blocked").await.unwrap_err().code,
        ErrorCode::Invalid
    );
    host.shutdown().await;
}
