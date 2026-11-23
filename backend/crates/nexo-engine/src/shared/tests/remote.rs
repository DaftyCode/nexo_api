//! A shared collection on a server played on loopback as WebDAV does: versions by ETag,
//! nothing sent again when nothing changed (`304`), a teammate's version never written over
//! (`412`), credentials asked for (`401`).
use super::*;
use std::sync::{Arc, Mutex};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
};

/// The server: the file and its version, whether it gives ETags, and what it was asked.
#[derive(Default)]
struct Server {
    file: Option<(Vec<u8>, u32)>,
    tags: bool,
    asked: Vec<String>,
}

const AUTH: &str = "authorization: basic YW5hOnNlY3JldA=="; // ana:secret

async fn handle(mut socket: tokio::net::TcpStream, server: Arc<Mutex<Server>>) {
    let mut request = Vec::new();
    let mut buffer = [0u8; 65536];
    let (head, body) = loop {
        let read = socket.read(&mut buffer).await.unwrap_or(0);
        request.extend_from_slice(&buffer[..read]);
        let text = String::from_utf8_lossy(&request).to_string();
        if let Some(end) = text.find("\r\n\r\n") {
            let head = text[..end].to_ascii_lowercase();
            let length = head
                .lines()
                .find_map(|line| line.strip_prefix("content-length:"))
                .map_or(0, |n| n.trim().parse::<usize>().unwrap_or(0));
            if request.len() >= end + 4 + length || read == 0 {
                break (head, request[end + 4..].to_vec());
            }
        } else if read == 0 {
            return;
        }
    };
    let header = |name: &str| {
        head.lines()
            .find_map(|line| line.strip_prefix(&format!("{name}:")))
            .map(|value| value.trim().to_owned())
    };
    let (status, tag, reply) = {
        let mut server = server.lock().unwrap();
        server.asked.push(
            head.lines().next().unwrap_or_default().to_owned()
                + &header("if-none-match")
                    .map(|tag| format!(" if-none-match {tag}"))
                    .unwrap_or_default()
                + &header("if-match")
                    .map(|tag| format!(" if-match {tag}"))
                    .unwrap_or_default(),
        );
        let current = server.file.as_ref().map(|file| format!("\"v{}\"", file.1));
        if !head.contains(&AUTH.to_ascii_lowercase()) {
            ("401 Unauthorized", None, Vec::new())
        } else if head.starts_with("get") {
            match &server.file {
                None => ("404 Not Found", None, Vec::new()),
                Some(_) if header("if-none-match") == current => {
                    ("304 Not Modified", current.clone(), Vec::new())
                }
                Some((bytes, _)) => (
                    "200 OK",
                    current.clone().filter(|_| server.tags),
                    bytes.clone(),
                ),
            }
        } else {
            let stale = match (header("if-match"), header("if-none-match")) {
                (Some(expected), _) => current.is_some() && Some(expected) != current,
                (None, Some(any)) => any == "*" && current.is_some(),
                (None, None) => false,
            };
            if stale {
                ("412 Precondition Failed", None, Vec::new())
            } else {
                let next = server.file.as_ref().map_or(1, |file| file.1 + 1);
                server.file = Some((body, next));
                let tag = format!("\"v{next}\"");
                ("201 Created", server.tags.then_some(tag), Vec::new())
            }
        }
    };
    let tag = tag
        .map(|tag| format!("etag: {tag}\r\n"))
        .unwrap_or_default();
    let head = format!(
        "HTTP/1.1 {status}\r\n{tag}content-length: {}\r\nconnection: close\r\n\r\n",
        reply.len()
    );
    let _ = socket.write_all(head.as_bytes()).await;
    let _ = socket.write_all(&reply).await;
}

async fn serve(tags: bool) -> (String, Arc<Mutex<Server>>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = Arc::new(Mutex::new(Server {
        tags,
        ..Server::default()
    }));
    let shared = server.clone();
    tokio::spawn(async move {
        while let Ok((socket, _)) = listener.accept().await {
            tokio::spawn(handle(socket, shared.clone()));
        }
    });
    (format!("http://{address}/dav/Shop.nexo-collection"), server)
}

fn at(url: &str) -> Value {
    json!({"location": {"kind": "url", "url": url},
           "resolvedAuth": {"scheme": "basic", "user": "ana", "password": "secret"}})
}
fn with(mut payload: Value, field: &str, value: Value) -> Value {
    payload[field] = value;
    payload
}

#[tokio::test]
async fn a_server_file_is_read_only_when_it_changed_and_never_written_over() {
    let (url, server) = serve(true).await;
    let (egress, ports) = (Policy::AllowAll, Vec::new());
    assert_eq!(
        read(&at(&url), &egress, &ports).await.unwrap(),
        json!({"found": false})
    );
    let written = write(&with(at(&url), "content", content("Shop")), &egress, &ports)
        .await
        .unwrap();
    assert_eq!(written["version"], "\"v1\"");
    let first = read(&at(&url), &egress, &ports).await.unwrap();
    assert_eq!(
        (first["version"].clone(), first["content"].clone()),
        (json!("\"v1\""), content("Shop"))
    );
    // Asked with the version it knows, the server sends nothing.
    let same = read(&with(at(&url), "known", json!("\"v1\"")), &egress, &ports)
        .await
        .unwrap();
    assert_eq!(
        same,
        json!({"found": true, "unchanged": true, "version": "\"v1\""})
    );
    // A teammate wrote v2: a write from v1 is refused, and so is a new file over it.
    let next = with(
        with(at(&url), "content", content("Ben")),
        "expected",
        json!("\"v1\""),
    );
    write(&next, &egress, &ports).await.unwrap();
    assert!(matches!(
        write(&next, &egress, &ports).await,
        Err(Error::Conflict)
    ));
    assert!(matches!(
        write(&with(at(&url), "content", content("New")), &egress, &ports).await,
        Err(Error::Conflict)
    ));
    let asked = server.lock().unwrap().asked.clone();
    assert!(
        asked.contains(&"get /dav/shop.nexo-collection http/1.1 if-none-match \"v1\"".to_owned()),
        "{asked:?}"
    );
    assert!(asked.iter().any(|line| line.ends_with("if-match \"v1\"")));
}

#[tokio::test]
async fn a_sealed_file_on_a_server_and_what_the_server_refuses() {
    let (url, _) = serve(false).await;
    let (egress, ports) = (Policy::AllowAll, Vec::new());
    let key = new_key()["key"].as_str().unwrap().to_owned();
    let sealed = with(
        with(at(&url), "content", content("Secret")),
        "resolvedKey",
        json!(key),
    );
    // Without ETags, the version is that of what was written, and then of what is read.
    let written = write(&sealed, &egress, &ports).await.unwrap();
    let read_back = read(&with(at(&url), "resolvedKey", json!(key)), &egress, &ports)
        .await
        .unwrap();
    assert_eq!(read_back["version"], written["version"]);
    assert_eq!(read_back["content"], content("Secret"));
    assert_eq!(
        read(&at(&url), &egress, &ports).await.unwrap()["locked"],
        true
    );
    let stranger = json!({"location": {"kind": "url", "url": url}});
    assert!(
        read(&stranger, &egress, &ports)
            .await
            .unwrap_err()
            .to_string()
            .contains("refused the credentials")
    );
    let token = with(
        stranger.clone(),
        "resolvedAuth",
        json!({"scheme": "bearer", "token": "t"}),
    );
    assert!(read(&token, &egress, &ports).await.is_err());
    for wrong in [
        "ftp://host/x.nexo-collection",
        "http://host/notes.txt",
        "not a url",
    ] {
        let place = json!({"location": {"kind": "url", "url": wrong}});
        assert!(read(&place, &egress, &ports).await.is_err(), "{wrong}");
    }
    // The egress policy decides whether the server may be reached.
    let private = Policy::DenyPrivate { allow: Vec::new() };
    assert!(read(&at(&url), &private, &ports).await.is_err());
}
