//! What the host keeps away from a driver and from what a driver says: the secrets of its
//! connections in logs and errors, and the destinations the egress policy does not allow.
mod common;

use common::{connection, fixture, statement};
use nexo_application::ports::ConnectionRoute;
use nexo_domain::hosts::AllowedHosts;
use nexo_driver_sdk::{ErrorCode, methods, statements::ExecuteResult};
use nexo_modules::ConnectionSettings;
use serde_json::json;

#[tokio::test]
async fn secrets_stay_out_of_the_log_and_of_errors() {
    let fixture = fixture();
    let host = &fixture.host;
    let mut leaking = connection("main");
    leaking.options.insert("leak".into(), "log".into());
    host.connect("test", leaking, Default::default())
        .await
        .unwrap();
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
    let error = host
        .connect("test", refused, Default::default())
        .await
        .unwrap_err();
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
    host.connect("test", to("allowed", "db.example.com"), Default::default())
        .await
        .unwrap();

    let error = host
        .connect(
            "test",
            to("blocked", "private.example.com"),
            Default::default(),
        )
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
        .connect(
            "test",
            to("limited", "db.example.com"),
            ConnectionSettings::hosts(limited.clone()),
        )
        .await;
    let error = error.unwrap_err();
    assert_eq!(error.code, ErrorCode::Network);
    assert!(error.message.contains("db-password:1"), "{}", error.message);
    host.connect(
        "test",
        to("within", "db.internal.test"),
        ConnectionSettings::hosts(limited),
    )
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

fn with_route(route: &ConnectionRoute) -> ConnectionSettings {
    ConnectionSettings {
        route: route.clone(),
        ..ConnectionSettings::default()
    }
}

#[tokio::test]
async fn a_connection_with_a_route_is_given_the_port_the_host_forwards() {
    let fixture = fixture();
    let host = &fixture.host;
    let route = ConnectionRoute {
        route: json!({"via": "ssh", "profile": "p1"}),
        profiles: json!({}),
    };
    let mut params = connection("tunnelled");
    params.host = Some("db.internal".into());
    params.port = Some(5432);
    let (opened, servers) = host.test("test", params.clone(), with_route(&route)).await;
    opened.unwrap();
    // The driver is told the loopback port; the name is never resolved here.
    assert_eq!(servers[0].host, "db.internal");
    assert_eq!(servers[0].addresses, ["127.0.0.1:15432"]);
    assert!(fixture.policy.asked.lock().unwrap().is_empty());
    params.host = Some("private.internal".into());
    let (refused, servers) = host.test("test", params, with_route(&route)).await;
    assert_eq!(refused.unwrap_err().code, ErrorCode::Network);
    assert!(!servers[0].allowed);
    assert_eq!(
        *fixture.policy.forwarded.lock().unwrap(),
        [
            ("db.internal".to_owned(), 5432),
            ("private.internal".to_owned(), 5432)
        ]
    );
    host.shutdown().await;
}
