use super::*;
use nexo_domain::hosts::AllowedHosts;

/// A policy that refuses the hosts named `private…`.
struct Policy {
    restrictive: bool,
}
#[async_trait]
impl NetworkPolicy for Policy {
    async fn check_destination(&self, host: &str, _: u16) -> Result<()> {
        if host.starts_with("private") {
            return Err(Error::Validation(format!(
                "Destination {host} is blocked by the egress policy"
            )));
        }
        Ok(())
    }
    /// The driver connects by name: nothing here asks for addresses.
    async fn resolve_destination(
        &self,
        host: &str,
        port: u16,
    ) -> Result<Vec<std::net::SocketAddr>> {
        self.check_destination(host, port)
            .await
            .map(|()| Vec::new())
    }
    fn restrictive(&self) -> bool {
        self.restrictive
    }
}
fn adapter(restrictive: bool) -> MongoAdapter {
    MongoAdapter::new(
        &std::env::temp_dir().join(format!("nexo-mongo-{}", uuid::Uuid::new_v4())),
        Arc::new(Policy { restrictive }),
    )
}

#[tokio::test]
async fn refuses_seeds_of_the_policy_and_of_secrets_before_connecting() {
    let error = adapter(true)
        .test(DatabaseConnection {
            uri: "mongodb://public.test,private.test:27018/?serverSelectionTimeoutMS=100".into(),
            ..Default::default()
        })
        .await
        .unwrap_err()
        .to_string();
    assert_eq!(
        error,
        "Nexo may not connect to private.test:27018: Destination private.test is blocked by the egress policy"
    );
    let error = adapter(false)
        .test(DatabaseConnection {
            uri: "mongodb://ana@db.other.test/?serverSelectionTimeoutMS=100".into(),
            password: Some("secret".into()),
            secret_hosts: vec![(
                "mongo-pass".into(),
                AllowedHosts::parse(&["*.example.com"]).unwrap(),
            )],
            ..Default::default()
        })
        .await
        .unwrap_err()
        .to_string();
    assert!(
        error.contains("secret mongo-pass cannot be sent to db.other.test"),
        "{error}"
    );
}

#[tokio::test]
async fn an_unreachable_server_is_explained() {
    // Port 9 (discard) on loopback: nothing answers there.
    let error = adapter(false)
        .test(DatabaseConnection {
            uri: "mongodb://127.0.0.1:9/?serverSelectionTimeoutMS=300&connectTimeoutMS=300".into(),
            ..Default::default()
        })
        .await
        .unwrap_err()
        .to_string();
    assert!(error.starts_with("No server answered:"), "{error}");
}

#[test]
fn reads_the_members_of_a_replica_set() {
    let hello = doc! {
        "setName": "rs0", "primary": "a:1",
        "hosts": ["a:1", "b:2"], "passives": ["c:3"], "arbiters": ["d:4"],
    };
    assert_eq!(
        members(&hello),
        vec![
            ("a:1".to_string(), "primary"),
            ("b:2".to_string(), "secondary"),
            ("c:3".to_string(), "passive"),
            ("d:4".to_string(), "arbiter"),
        ]
    );
    assert!(members(&doc! {"ok": 1}).is_empty());
    assert_eq!(
        flavor(&doc! {"ferretdb": {"version": "2.0"}}, &doc! {}).as_deref(),
        Some("FerretDB")
    );
    assert_eq!(flavor(&doc! {"version": "8.0.4"}, &doc! {}), None);
}

/// The driver builds its TLS settings from rustls' default aws-lc-rs provider: it must
/// prefer the post-quantum key exchange, as every other connection of Nexo does.
#[test]
fn tls_prefers_post_quantum_key_exchange() {
    let provider = rustls::crypto::aws_lc_rs::default_provider();
    assert_eq!(
        provider.kx_groups[0].name(),
        rustls::NamedGroup::X25519MLKEM768
    );
}
