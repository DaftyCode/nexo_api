//! What needs no server. The driver over the protocol, and against real servers, is tested
//! in `tests/` and in Nexo's contract tests.
use super::*;

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

#[test]
fn it_says_it_is_mongodb_and_answers_documents() {
    let hello = MongoDriver::default().hello();
    assert_eq!(hello.driver.id, "mongodb");
    assert_eq!(hello.capabilities.extensions, ["document"]);
}
