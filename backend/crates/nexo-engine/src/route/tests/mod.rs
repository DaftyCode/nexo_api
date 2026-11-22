mod fakes;

use super::*;
use crate::egress::Policy;
use fakes::{echo, http_proxy, socks_proxy};
use serde_json::json;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

async fn round_trip(dialer: &Dialer, host: &str, port: u16) -> Result<String> {
    let mut stream = dialer.connect(host, port).await?;
    stream.write_all(b"ping").await.unwrap();
    let mut answer = [0_u8; 4];
    stream.read_exact(&mut answer).await.unwrap();
    Ok(String::from_utf8_lossy(&answer).into_owned())
}

fn dialer(route: Value) -> Dialer {
    Dialer::new(
        Route::from_settings(&json!({ "route": route })).unwrap(),
        Policy::AllowAll,
        vec![],
    )
}

#[test]
fn routes_are_read_from_settings_and_from_the_older_proxy() {
    assert_eq!(Route::from_settings(&json!({})).unwrap(), Route::Direct);
    assert_eq!(
        Route::from_settings(&json!({"route": {"via": "direct", "host": "x"}})).unwrap(),
        Route::Direct
    );
    let socks = Route::from_settings(&json!({"route": {
        "via": "socks5", "host": " proxy.test ", "port": "1081", "username": "ada",
        "password": "secret", "remoteDns": true
    }}))
    .unwrap();
    assert_eq!(
        socks.proxy_url().as_deref(),
        Some("socks5h://proxy.test:1081")
    );
    assert_eq!(socks.credentials().unwrap().username, "ada");
    assert!(!format!("{socks:?}").contains("secret"));
    let older = Route::from_settings(&json!({"proxy": {"uri": "socks5://[::1]:1090"}})).unwrap();
    assert_eq!(older.proxy_url().as_deref(), Some("socks5://[::1]:1090"));
    let fields = Route::from_settings(&json!({"proxy": {"host": "p", "port": 3128}})).unwrap();
    assert_eq!(fields.proxy_url().as_deref(), Some("http://p:3128"));
    assert_eq!(
        Route::from_settings(&json!({"proxy": {"host": "p", "disabled": true}})).unwrap(),
        Route::Direct
    );
    assert_eq!(
        Route::from_settings(&json!({"route": {"via": "http", "host": "p"}}))
            .unwrap()
            .proxy(),
        Some(&Endpoint {
            host: "p".into(),
            port: 8080
        })
    );
    for (route, message) in [
        (json!({"via": "socks5"}), "Enter the host of the proxy"),
        (
            json!({"via": "http", "host": "p", "port": 70000}),
            "Invalid proxy port 70000",
        ),
        (
            json!({"via": "carrier", "host": "p"}),
            "Unknown way to connect: carrier",
        ),
    ] {
        let error = Route::from_settings(&json!({ "route": route })).unwrap_err();
        assert_eq!(error.to_string(), message);
    }
}

#[test]
fn a_route_may_name_a_proxy_profile_of_its_own_kind() {
    let profiles = json!({
        "p1": {"proxy": "socks5", "host": "proxy.lan", "port": 1081, "username": "ada",
            "password": "secret", "remoteDns": true},
        "p2": {"proxy": "http", "host": "web.lan"},
    });
    let route = |via: &str, profile: &str| {
        Route::with_profiles(
            &json!({"route": {"via": via, "profile": profile, "host": "ignored"}}),
            &profiles,
        )
    };
    let socks = route("socks5", "p1").unwrap();
    assert_eq!(
        socks.proxy_url().as_deref(),
        Some("socks5h://proxy.lan:1081")
    );
    assert_eq!(socks.credentials().unwrap().password, "secret");
    assert_eq!(
        route("http", "p2").unwrap().proxy_url().as_deref(),
        Some("http://web.lan:8080")
    );
    for (via, profile) in [("socks5", "p2"), ("http", "gone")] {
        assert_eq!(
            route(via, profile).unwrap_err().to_string(),
            "The proxy profile of this connection no longer exists"
        );
    }
}

#[tokio::test]
async fn an_http_proxy_opens_a_tunnel_with_connect_and_its_credentials() {
    let upstream = echo().await;
    let (port, asked) = http_proxy("200 Connection established", upstream).await;
    let through = dialer(json!({"via": "http", "host": "127.0.0.1", "port": port,
        "username": "ada", "password": "pw"}));
    assert_eq!(
        round_trip(&through, "api.internal", 8443).await.unwrap(),
        "ping"
    );
    let head = asked.lock().unwrap()[0].clone();
    assert!(head.starts_with("CONNECT api.internal:8443 HTTP/1.1\r\nHost: api.internal:8443\r\n"));
    assert!(head.contains("Proxy-Authorization: Basic YWRhOnB3\r\n"));

    let (port, _) = http_proxy("407 Proxy Authentication Required", upstream).await;
    let denied = dialer(json!({"via": "http", "host": "127.0.0.1", "port": port}));
    let error = round_trip(&denied, "api.internal", 80).await.unwrap_err();
    assert!(
        error
            .to_string()
            .contains("asks for a user name and password")
    );
    let (port, _) = http_proxy("403 Forbidden", upstream).await;
    let refused = dialer(json!({"via": "http", "host": "127.0.0.1", "port": port}));
    let error = round_trip(&refused, "[::1]", 80).await.unwrap_err();
    assert_eq!(
        error.to_string(),
        "The proxy refused to reach [::1]:80: HTTP/1.1 403 Forbidden"
    );
}

#[tokio::test]
async fn a_socks5_proxy_relays_with_or_without_a_password_and_resolves_names_when_asked() {
    let upstream = echo().await;
    let (port, asked) = socks_proxy(None, upstream).await;
    let remote =
        dialer(json!({"via": "socks5", "host": "127.0.0.1", "port": port, "remoteDns": true}));
    assert_eq!(
        round_trip(&remote, "db.internal", 5432).await.unwrap(),
        "ping"
    );
    let local = dialer(json!({"via": "socks5", "host": "127.0.0.1", "port": port}));
    assert_eq!(round_trip(&local, "127.0.0.1", 9).await.unwrap(), "ping");
    assert_eq!(*asked.lock().unwrap(), ["db.internal:5432", "127.0.0.1:9"]);

    let (port, asked) = socks_proxy(Some("pw"), upstream).await;
    let signed = dialer(json!({"via": "socks5", "host": "127.0.0.1", "port": port,
        "username": "ada", "password": "pw", "remoteDns": true}));
    assert_eq!(
        round_trip(&signed, "db.internal", 5432).await.unwrap(),
        "ping"
    );
    assert_eq!(*asked.lock().unwrap(), ["user ada", "db.internal:5432"]);
    let wrong = dialer(json!({"via": "socks5", "host": "127.0.0.1", "port": port,
        "username": "ada", "password": "no", "remoteDns": true}));
    let error = round_trip(&wrong, "db.internal", 5432).await.unwrap_err();
    assert!(
        error
            .to_string()
            .starts_with("The SOCKS5 proxy refused to reach db.internal:5432")
    );
    let closed =
        dialer(json!({"via": "socks5", "host": "127.0.0.1", "port": 1, "remoteDns": true}));
    let error = closed.connect("db.internal", 5432).await.unwrap_err();
    assert!(
        error
            .to_string()
            .starts_with("Cannot connect to the proxy 127.0.0.1:1"),
        "{error}"
    );
}

#[tokio::test]
async fn the_egress_policy_checks_the_proxy_and_the_destination_behind_it() {
    let strict = Policy::parse(Some("deny-private"), Some("proxy.allowed,10.0.0.0/8"));
    let through = |route: Value| {
        Dialer::new(
            Route::from_settings(&json!({ "route": route })).unwrap(),
            strict.clone(),
            vec![],
        )
    };
    // A private destination stays refused through a proxy, whoever resolves its name.
    let socks =
        through(json!({"via": "socks5", "host": "10.1.2.3", "port": 1080, "remoteDns": true}));
    let error = socks.check("192.168.1.5", 80).await.unwrap_err();
    assert!(error.to_string().contains("blocked by the egress policy"));
    let error = socks.check("db.invalid", 80).await.unwrap_err();
    assert_eq!(
        error.to_string(),
        "db.invalid cannot be checked against the egress policy here; add it to NEXO_EGRESS_ALLOW to reach it through a proxy"
    );
    assert!(socks.check("proxy.allowed", 80).await.is_ok());
    // The proxy itself must be reachable.
    let blocked = through(json!({"via": "http", "host": "127.0.0.1", "port": 3128}));
    let error = blocked.check("proxy.allowed", 80).await.unwrap_err();
    assert!(error.to_string().contains("127.0.0.1"));
    // Every destination allowed: the name is left to the proxy, never resolved here.
    let open =
        dialer(json!({"via": "socks5", "host": "127.0.0.1", "port": 1080, "remoteDns": true}));
    assert!(open.check("db.invalid", 80).await.is_ok());
}

#[tokio::test]
async fn adapters_get_a_socks5_proxy_at_an_allowed_address_and_never_an_http_one() {
    assert_eq!(
        dialer(json!({"via": "direct"}))
            .socks_proxy()
            .await
            .unwrap(),
        None
    );
    let http = dialer(json!({"via": "http", "host": "127.0.0.1", "port": 8080}));
    assert!(
        http.socks_proxy()
            .await
            .unwrap_err()
            .to_string()
            .contains("HTTP proxy")
    );
    let socks = dialer(json!({"via": "socks5", "host": "localhost", "port": 1081,
        "username": "ada", "password": "pw"}));
    let proxy = socks.socks_proxy().await.unwrap().unwrap();
    assert!(
        ["127.0.0.1", "::1"].contains(&proxy.host.as_str()),
        "{proxy:?}"
    );
    assert_eq!(proxy.port, 1081);
    assert_eq!(proxy.credentials, Some(("ada".into(), "pw".into())));
    assert!(!format!("{proxy:?}").contains("pw"));
}
