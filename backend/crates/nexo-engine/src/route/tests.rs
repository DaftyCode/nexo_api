use super::*;
use serde_json::json;
use std::sync::{Arc, Mutex};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
};

/// An echo server: what it reads, it writes back.
async fn echo() -> SocketAddr {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    tokio::spawn(async move {
        while let Ok((mut socket, _)) = listener.accept().await {
            tokio::spawn(async move {
                let (mut read, mut write) = socket.split();
                let _ = tokio::io::copy(&mut read, &mut write).await;
            });
        }
    });
    address
}

/// What a fake proxy was asked: the destination and the credentials.
type Asked = Arc<Mutex<Vec<String>>>;

/// An HTTP proxy that answers `CONNECT` with `status` and then relays to `upstream`.
async fn http_proxy(status: &'static str, upstream: SocketAddr) -> (u16, Asked) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let asked = Asked::default();
    let seen = asked.clone();
    tokio::spawn(async move {
        while let Ok((mut socket, _)) = listener.accept().await {
            let seen = seen.clone();
            tokio::spawn(async move {
                let mut head = Vec::new();
                let mut byte = [0_u8; 1];
                while !head.ends_with(b"\r\n\r\n") {
                    if socket.read(&mut byte).await.unwrap_or(0) == 0 {
                        return;
                    }
                    head.push(byte[0]);
                }
                seen.lock()
                    .unwrap()
                    .push(String::from_utf8_lossy(&head).into_owned());
                let answer = format!("HTTP/1.1 {status}\r\nVia: test\r\n\r\n");
                socket.write_all(answer.as_bytes()).await.unwrap();
                if status.starts_with("200") {
                    let mut target = tokio::net::TcpStream::connect(upstream).await.unwrap();
                    let _ = tokio::io::copy_bidirectional(&mut socket, &mut target).await;
                }
            });
        }
    });
    (port, asked)
}

/// A SOCKS5 proxy (RFC 1928 and 1929) that relays every request to `upstream` and records
/// the destination asked for, as `name:port` or `ip:port`, and the user name.
async fn socks_proxy(password: Option<&'static str>, upstream: SocketAddr) -> (u16, Asked) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let asked = Asked::default();
    let seen = asked.clone();
    tokio::spawn(async move {
        while let Ok((mut socket, _)) = listener.accept().await {
            let seen = seen.clone();
            tokio::spawn(async move {
                let mut greeting = [0_u8; 2];
                socket.read_exact(&mut greeting).await.unwrap();
                let mut methods = vec![0_u8; greeting[1] as usize];
                socket.read_exact(&mut methods).await.unwrap();
                if let Some(expected) = password {
                    socket.write_all(&[5, 2]).await.unwrap();
                    let mut version = [0_u8; 2];
                    socket.read_exact(&mut version).await.unwrap();
                    let mut user = vec![0_u8; version[1] as usize];
                    socket.read_exact(&mut user).await.unwrap();
                    let mut length = [0_u8; 1];
                    socket.read_exact(&mut length).await.unwrap();
                    let mut pass = vec![0_u8; length[0] as usize];
                    socket.read_exact(&mut pass).await.unwrap();
                    let ok = pass == expected.as_bytes();
                    seen.lock()
                        .unwrap()
                        .push(format!("user {}", String::from_utf8_lossy(&user)));
                    socket
                        .write_all(&[1, if ok { 0 } else { 1 }])
                        .await
                        .unwrap();
                    if !ok {
                        return;
                    }
                } else {
                    socket.write_all(&[5, 0]).await.unwrap();
                }
                let mut request = [0_u8; 4];
                socket.read_exact(&mut request).await.unwrap();
                let destination = match request[3] {
                    3 => {
                        let mut length = [0_u8; 1];
                        socket.read_exact(&mut length).await.unwrap();
                        let mut name = vec![0_u8; length[0] as usize];
                        socket.read_exact(&mut name).await.unwrap();
                        String::from_utf8_lossy(&name).into_owned()
                    }
                    _ => {
                        let mut ip = [0_u8; 4];
                        socket.read_exact(&mut ip).await.unwrap();
                        std::net::Ipv4Addr::from(ip).to_string()
                    }
                };
                let mut port = [0_u8; 2];
                socket.read_exact(&mut port).await.unwrap();
                seen.lock()
                    .unwrap()
                    .push(format!("{destination}:{}", u16::from_be_bytes(port)));
                socket
                    .write_all(&[5, 0, 0, 1, 0, 0, 0, 0, 0, 0])
                    .await
                    .unwrap();
                let mut target = tokio::net::TcpStream::connect(upstream).await.unwrap();
                let _ = tokio::io::copy_bidirectional(&mut socket, &mut target).await;
            });
        }
    });
    (port, asked)
}

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
