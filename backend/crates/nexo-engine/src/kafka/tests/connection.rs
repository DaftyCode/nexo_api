//! Connecting: SASL, the brokers a cluster announces and the settings from a payload.
use super::super::*;
use super::*;

#[tokio::test]
async fn authenticates_with_scram_and_plain() {
    for mechanism in [
        sasl::Mechanism::ScramSha256,
        sasl::Mechanism::ScramSha512,
        sasl::Mechanism::Plain,
    ] {
        let (port, _) = start(Broker {
            sasl: Some((mechanism, "alice".into(), "s3cret".into())),
            other: None,
        })
        .await;
        let with = |password: &str| Settings {
            sasl: Some(Sasl {
                mechanism,
                username: "alice".into(),
                password: password.into(),
            }),
            ..settings(port)
        };
        let mut cluster = Cluster::connect(with("s3cret")).await.unwrap();
        cluster
            .produce(message("orders", Some(0), None, "hi"))
            .await
            .unwrap();
        let error = Cluster::connect(with("wrong"))
            .await
            .err()
            .unwrap()
            .to_string();
        assert!(
            error.contains("SaslAuthenticationFailed") || error.contains("bad credentials"),
            "{error}"
        );
        let none = Cluster::connect(settings(port)).await;
        assert!(
            none.is_ok(),
            "the broker does not require it from unauthenticated clients"
        );
    }
    let (port, _) = start(Broker {
        sasl: Some((sasl::Mechanism::Plain, "alice".into(), "p".into())),
        other: None,
    })
    .await;
    let refused = Cluster::connect(Settings {
        sasl: Some(Sasl {
            mechanism: sasl::Mechanism::ScramSha256,
            username: "alice".into(),
            password: "p".into(),
        }),
        ..settings(port)
    })
    .await
    .err()
    .unwrap()
    .to_string();
    assert!(
        refused.contains("does not accept SCRAM-SHA-256; it accepts PLAIN"),
        "{refused}"
    );
}

#[tokio::test]
async fn announced_brokers_pass_the_egress_policy_and_secret_hosts() {
    let (port, _) = start(Broker {
        sasl: None,
        other: Some(("10.20.30.40".into(), 9092)),
    })
    .await;
    // The bootstrap broker is the user's own loopback service; the one it announces is not.
    let mut cluster = Cluster::connect(Settings {
        egress: Policy::DenyPrivate { allow: Vec::new() },
        loopback_ports: vec![port],
        ..settings(port)
    })
    .await
    .unwrap();
    cluster
        .produce(message("orders", Some(0), None, "ok"))
        .await
        .unwrap();
    let blocked = cluster
        .produce(message("remote", Some(0), None, "no"))
        .await
        .unwrap_err()
        .to_string();
    assert!(blocked.contains("egress policy"), "{blocked}");

    let restricted = Settings {
        sasl: Some(Sasl {
            mechanism: sasl::Mechanism::Plain,
            username: "u".into(),
            password: "vault-value".into(),
        }),
        restricted: vec![Restricted {
            name: "kafka".into(),
            value: "vault-value".into(),
            hosts: nexo_domain::hosts::AllowedHosts::stored(&["kafka.example.com"]),
        }],
        ..settings(port)
    };
    let denied = Cluster::connect(restricted)
        .await
        .err()
        .unwrap()
        .to_string();
    assert!(
        denied.contains("Secret kafka cannot be sent to 127.0.0.1"),
        "{denied}"
    );
}

#[test]
fn settings_come_from_the_payload_with_vault_secrets() {
    let payload = json!({
        "url": "kafka://broker-1:9093, broker-2 ,[::1]:19092",
        "saslMechanism": "SCRAM-SHA-512",
        "username": "app",
        "password": "{{vault:kafka}}",
        "resolvedSecrets": {"kafka": "from-vault"},
        "secretHosts": {"kafka": ["*.example.com"]},
        "clientId": "orders-tool",
    });
    let settings = Settings::from_payload(&payload, Policy::AllowAll, Vec::new()).unwrap();
    assert_eq!(
        settings.bootstrap,
        [
            ("broker-1".to_string(), 9093),
            ("broker-2".to_string(), 9092),
            ("::1".to_string(), 19092)
        ]
    );
    let credentials = settings.sasl.as_ref().unwrap();
    assert_eq!(credentials.password, "from-vault");
    assert_eq!(credentials.mechanism, sasl::Mechanism::ScramSha512);
    assert_eq!(settings.client_id, "orders-tool");
    assert!(settings.check_host("kafka.example.com").is_ok());
    assert!(settings.check_host("evil.test").is_err());
    assert!(settings.tls.is_none());
    let tls = Settings::from_payload(
        &json!({"url": "b:1", "tls": true}),
        Policy::AllowAll,
        Vec::new(),
    )
    .unwrap();
    assert!(tls.tls.is_some() && tls.sasl.is_none());
    for (payload, error) in [
        (json!({"url": " , "}), "bootstrap servers"),
        (json!({"url": "b:x9"}), "Invalid broker"),
        (
            json!({"url": "b", "saslMechanism": "PLAIN"}),
            "SASL user name",
        ),
        (
            json!({"url": "b", "saslMechanism": "GSSAPI", "username": "u"}),
            "Unsupported SASL",
        ),
    ] {
        let message = Settings::from_payload(&payload, Policy::AllowAll, Vec::new())
            .err()
            .unwrap()
            .to_string();
        assert!(message.contains(error), "{payload}: {message}");
    }
}
