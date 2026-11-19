mod bastion;

use super::*;
use crate::route::{Dialer, Route};
use bastion::{CLIENT_KEY, HOST_KEY, HOST_PUBLIC, LOCKED_KEY, OTHER_KEY};
use russh::keys::PublicKey;
use std::net::SocketAddr;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
};

/// The known_hosts file of this process: the tunnels are process-wide, and the first engine
/// (or this) sets it.
fn known_hosts() -> PathBuf {
    let path = std::env::temp_dir()
        .join(format!("nexo-ssh-{}", uuid::Uuid::new_v4()))
        .join("known_hosts");
    tunnels().set_known_hosts(path);
    tunnels().known_hosts().unwrap()
}

/// An upstream server: an echo, or an HTTP server that answers `ok`.
async fn upstream(http: bool) -> SocketAddr {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    tokio::spawn(async move {
        while let Ok((mut socket, _)) = listener.accept().await {
            tokio::spawn(async move {
                if !http {
                    let (mut read, mut write) = socket.split();
                    let _ = tokio::io::copy(&mut read, &mut write).await;
                    return;
                }
                let mut head = Vec::new();
                let mut byte = [0_u8; 1];
                while !head.ends_with(b"\r\n\r\n") && socket.read(&mut byte).await.unwrap_or(0) == 1
                {
                    head.push(byte[0]);
                }
                let host = String::from_utf8_lossy(&head)
                    .lines()
                    .find_map(|line| {
                        line.strip_prefix("host: ")
                            .or(line.strip_prefix("Host: "))
                            .map(String::from)
                    })
                    .unwrap_or_default();
                let body = format!("ok from {host}");
                let answer = format!(
                    "HTTP/1.1 200 OK\r\nContent-Length: {}\r\n\r\n{body}",
                    body.len()
                );
                let _ = socket.write_all(answer.as_bytes()).await;
            });
        }
    });
    address
}

fn target(port: u16, auth: SshAuth) -> SshTarget {
    SshTarget {
        profile: "bastion".into(),
        host: "127.0.0.1".into(),
        port,
        username: "ana".into(),
        auth,
    }
}
fn password(text: &str) -> SshAuth {
    SshAuth::Password(text.into())
}
fn dialer(target: &SshTarget) -> Dialer {
    Dialer::new(Route::Ssh(target.clone()), Policy::AllowAll, vec![])
}

/// Trusts the key the server shows, as the person does in the SSH profile.
async fn trust(target: &SshTarget) {
    let shown = tunnels()
        .test(target, &Policy::AllowAll, &[])
        .await
        .unwrap();
    if shown["trusted"] == false {
        tunnels()
            .trust(
                &target.host,
                target.port,
                shown["fingerprint"].as_str().unwrap(),
            )
            .unwrap();
    }
}

async fn round_trip(dialer: &Dialer) -> nexo_domain::Result<String> {
    let mut stream = dialer.connect("db.internal", 5432).await?;
    stream.write_all(b"ping").await.unwrap();
    let mut answer = [0_u8; 4];
    stream.read_exact(&mut answer).await.unwrap();
    Ok(String::from_utf8_lossy(&answer).into_owned())
}

#[tokio::test]
async fn an_unknown_server_is_trusted_once_and_its_tunnel_reaches_what_only_it_sees() {
    let known = known_hosts();
    let (port, asked) = bastion::start(HOST_KEY, upstream(false).await).await;
    let target = target(port, password("pw"));
    let error = round_trip(&dialer(&target)).await.unwrap_err().to_string();
    assert!(
        error.contains(&format!(
            "The SSH server 127.0.0.1:{port} is not trusted yet"
        )),
        "{error}"
    );
    let fingerprint = known::fingerprint(&PublicKey::from_openssh(HOST_PUBLIC).unwrap());
    assert!(
        error.contains(&format!("ssh-ed25519 {fingerprint}")),
        "{error}"
    );

    let shown = tunnels()
        .test(&target, &Policy::AllowAll, &[])
        .await
        .unwrap();
    assert_eq!(shown["trusted"], false);
    assert_eq!(shown["fingerprint"], fingerprint);
    let wrong = tunnels()
        .trust("127.0.0.1", port, "SHA256:other")
        .unwrap_err();
    assert!(wrong.to_string().contains("has not shown that key"));
    tunnels().trust("127.0.0.1", port, &fingerprint).unwrap();
    assert!(
        std::fs::read_to_string(&known)
            .unwrap()
            .contains(&format!("[127.0.0.1]:{port} ssh-ed25519"))
    );

    assert_eq!(round_trip(&dialer(&target)).await.unwrap(), "ping");
    assert_eq!(round_trip(&dialer(&target)).await.unwrap(), "ping");
    assert_eq!(
        *asked.lock().unwrap(),
        ["db.internal:5432", "db.internal:5432"]
    );
    let tested = tunnels()
        .test(&target, &Policy::AllowAll, &[])
        .await
        .unwrap();
    assert_eq!(tested["trusted"], true);

    // Adapters that connect on their own (MongoDB) get the tunnel's loopback SOCKS5 proxy.
    let proxy = dialer(&target).socks_proxy().await.unwrap().unwrap();
    assert_eq!(proxy.host, "127.0.0.1");
    let (username, password) = proxy.credentials.clone().unwrap();
    let stream = TcpStream::connect(("127.0.0.1", proxy.port)).await.unwrap();
    let credentials = crate::route::Credentials { username, password };
    let mut stream =
        crate::route::handshake::socks5(stream, "db.internal", 5432, None, Some(&credentials))
            .await
            .unwrap();
    stream.write_all(b"ping").await.unwrap();
    let mut answer = [0_u8; 4];
    stream.read_exact(&mut answer).await.unwrap();
    assert_eq!(&answer, b"ping");
}

#[tokio::test]
async fn a_server_whose_key_changed_is_blocked() {
    let known = known_hosts();
    let (port, _) = bastion::start(OTHER_KEY, upstream(false).await).await;
    // The key Nexo trusted for this server before.
    known::learn(
        &known,
        "127.0.0.1",
        port,
        &PublicKey::from_openssh(HOST_PUBLIC).unwrap(),
    )
    .unwrap();
    let error = round_trip(&dialer(&target(port, password("pw"))))
        .await
        .unwrap_err();
    assert!(
        error.to_string().contains(&format!(
            "The key of the SSH server 127.0.0.1:{port} changed"
        )),
        "{error}"
    );
}

#[tokio::test]
async fn it_signs_in_with_a_key_or_a_locked_key_and_says_why_it_cannot() {
    known_hosts();
    let (port, _) = bastion::start(HOST_KEY, upstream(false).await).await;
    trust(&target(port, password("pw"))).await;
    let key = |pem: &str, passphrase: Option<&str>| SshAuth::Key {
        pem: pem.into(),
        passphrase: passphrase.map(String::from),
    };
    for auth in [key(CLIENT_KEY, None), key(LOCKED_KEY, Some("secreto"))] {
        assert_eq!(
            round_trip(&dialer(&target(port, auth))).await.unwrap(),
            "ping"
        );
    }
    let error = round_trip(&dialer(&target(port, key(LOCKED_KEY, Some("no")))))
        .await
        .unwrap_err();
    assert!(
        error
            .to_string()
            .starts_with("The private key of the SSH profile cannot be read")
    );
    let error = round_trip(&dialer(&target(port, password("no"))))
        .await
        .unwrap_err();
    assert_eq!(
        error.to_string(),
        format!("The SSH server 127.0.0.1:{port} refused the user ana with that password")
    );
}

#[tokio::test]
async fn http_requests_go_through_the_tunnel_and_its_proxy_asks_for_its_password() {
    known_hosts();
    let (port, asked) = bastion::start(HOST_KEY, upstream(true).await).await;
    let target = target(port, password("pw"));
    trust(&target).await;
    let dialer = dialer(&target);
    let (proxy, credentials) = dialer.http_proxy().unwrap().unwrap();
    let credentials = credentials.unwrap();
    dialer.check("api.internal", 80).await.unwrap();
    let client = reqwest::Client::builder()
        .proxy(
            reqwest::Proxy::all(&proxy)
                .unwrap()
                .basic_auth(&credentials.username, &credentials.password),
        )
        .build()
        .unwrap();
    let body = client
        .get("http://api.internal/orders")
        .send()
        .await
        .unwrap()
        .text()
        .await
        .unwrap();
    assert_eq!(body, "ok from api.internal");
    assert_eq!(*asked.lock().unwrap(), ["api.internal:80"]);

    // Without the tunnel's password, its loopback proxy lets no one through.
    let tunnel = tunnels().tunnel(&target, &Policy::AllowAll, &[]).unwrap();
    let mut anonymous = TcpStream::connect(("127.0.0.1", tunnel.port))
        .await
        .unwrap();
    anonymous.write_all(&[5, 1, 0]).await.unwrap();
    let mut answer = [0_u8; 2];
    anonymous.read_exact(&mut answer).await.unwrap();
    assert_eq!(answer, [5, 0xff]);
    let mut guessing = TcpStream::connect(("127.0.0.1", tunnel.port))
        .await
        .unwrap();
    guessing
        .write_all(&[
            5, 1, 2, 1, 4, b'n', b'e', b'x', b'o', 5, b'g', b'u', b'e', b's', b's',
        ])
        .await
        .unwrap();
    let mut answer = [0_u8; 4];
    guessing.read_exact(&mut answer).await.unwrap();
    assert_eq!(answer, [5, 2, 1, 1]);
}

#[test]
fn a_profile_becomes_a_target_without_showing_its_secrets() {
    let profile = serde_json::json!({"host": "bastion.example.com", "username": "ana",
        "auth": "key", "privateKey": "-----BEGIN", "passphrase": "secreto"});
    let target = SshTarget::from_profile("p1", &profile).unwrap();
    assert_eq!(target.port, 22);
    assert_eq!(
        format!("{target:?}"),
        "SshTarget(p1, ana@bastion.example.com:22)"
    );
    let missing = serde_json::json!({"host": "b", "username": "ana", "auth": "key"});
    let error = SshTarget::from_profile("p1", &missing).unwrap_err();
    assert_eq!(
        error.to_string(),
        "The private key of the SSH profile is not in the vault"
    );
    let route = Route::with_profiles(
        &serde_json::json!({"route": {"via": "ssh", "profile": "gone"}}),
        &serde_json::json!({}),
    );
    assert_eq!(
        route.unwrap_err().to_string(),
        "The SSH profile of this connection no longer exists"
    );
}
