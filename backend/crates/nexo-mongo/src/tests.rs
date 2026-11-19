use super::*;
use nexo_application::ports::{ConnectionRoute, SocksProxy};
use nexo_domain::hosts::AllowedHosts;
use serde_json::json;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

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
    /// A route names the proxy's port; HTTP proxies are refused, as the engine does.
    async fn socks_proxy(&self, route: &ConnectionRoute) -> Result<Option<SocksProxy>> {
        match route.route["via"].as_str() {
            Some("socks5") => Ok(Some(SocksProxy {
                host: "127.0.0.1".into(),
                port: route.route["port"].as_u64().unwrap_or(1080) as u16,
                credentials: Some(("ana".into(), "pw".into())),
            })),
            Some("http") => Err(Error::Validation("No HTTP proxies here".into())),
            _ => Ok(None),
        }
    }
    /// Names behind the proxy are checked as the far side sees them: `hidden…` is refused.
    async fn check_routed_destination(&self, host: &str, _: u16) -> Result<()> {
        if host.starts_with("hidden") {
            return Err(Error::Validation(format!(
                "{host} is refused behind the proxy"
            )));
        }
        Ok(())
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

/// A SOCKS5 proxy that signs in `ana`/`pw`, records each destination asked for and then
/// hangs up, as if the destination did not answer.
async fn recording_proxy() -> (u16, Arc<Mutex<Vec<String>>>) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let asked = Arc::new(Mutex::new(Vec::new()));
    let recorded = asked.clone();
    tokio::spawn(async move {
        while let Ok((mut stream, _)) = listener.accept().await {
            let recorded = recorded.clone();
            tokio::spawn(async move {
                let mut head = [0u8; 2];
                stream.read_exact(&mut head).await?;
                let mut methods = vec![0u8; head[1] as usize];
                stream.read_exact(&mut methods).await?;
                stream.write_all(&[5, 2]).await?;
                let mut version = [0u8; 2];
                stream.read_exact(&mut version).await?;
                let mut user = vec![0u8; version[1] as usize];
                stream.read_exact(&mut user).await?;
                let mut length = [0u8; 1];
                stream.read_exact(&mut length).await?;
                let mut password = vec![0u8; length[0] as usize];
                stream.read_exact(&mut password).await?;
                let ok = user == b"ana" && password == b"pw";
                stream.write_all(&[1, if ok { 0 } else { 1 }]).await?;
                let mut request = [0u8; 5];
                stream.read_exact(&mut request).await?;
                let mut name = vec![0u8; request[4] as usize + 2];
                stream.read_exact(&mut name).await?;
                let port = u16::from_be_bytes([name[name.len() - 2], name[name.len() - 1]]);
                let host = String::from_utf8_lossy(&name[..name.len() - 2]).to_string();
                recorded.lock().unwrap().push(format!("{host}:{port}"));
                Ok::<_, std::io::Error>(())
            });
        }
    });
    (port, asked)
}

#[tokio::test]
async fn connections_with_a_route_go_through_its_proxy_by_name() {
    let (port, asked) = recording_proxy().await;
    let routed = |uri: &str, route: serde_json::Value| DatabaseConnection {
        uri: uri.into(),
        route: ConnectionRoute {
            route,
            profiles: serde_json::Value::Null,
        },
        ..Default::default()
    };
    let socks = json!({"via": "socks5", "port": port});
    let uri = "mongodb://db.internal:27017/?serverSelectionTimeoutMS=300&connectTimeoutMS=300";
    let error = adapter(false)
        .test(routed(uri, socks.clone()))
        .await
        .unwrap_err()
        .to_string();
    assert!(error.starts_with("No server answered:"), "{error}");
    assert!(
        asked
            .lock()
            .unwrap()
            .contains(&"db.internal:27017".to_string()),
        "{asked:?}"
    );

    let hidden = adapter(false)
        .test(routed("mongodb://hidden.internal", socks))
        .await
        .unwrap_err()
        .to_string();
    assert_eq!(
        hidden,
        "Nexo may not connect to hidden.internal:27017: hidden.internal is refused behind the proxy"
    );
    let http = adapter(false)
        .test(routed("mongodb://db.internal", json!({"via": "http"})))
        .await
        .unwrap_err()
        .to_string();
    assert_eq!(http, "No HTTP proxies here");
}
