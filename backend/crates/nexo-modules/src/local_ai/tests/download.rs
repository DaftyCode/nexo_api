//! Downloads from a loopback server: checked, resumed, refused.
use super::*;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
};

/// Serves `body` once per connection, from the byte a `Range` asks for.
async fn serve(body: Vec<u8>) -> String {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    tokio::spawn(async move {
        while let Ok((mut socket, _)) = listener.accept().await {
            let body = body.clone();
            tokio::spawn(async move {
                let mut request = vec![0u8; 4096];
                let read = socket.read(&mut request).await.unwrap_or(0);
                let request = String::from_utf8_lossy(&request[..read]).to_ascii_lowercase();
                let from = request
                    .lines()
                    .find_map(|line| line.strip_prefix("range: bytes="))
                    .and_then(|range| range.trim_end_matches('-').parse::<usize>().ok());
                let (status, part) = match from {
                    Some(from) => ("206 Partial Content", &body[from..]),
                    None => ("200 OK", &body[..]),
                };
                let head = format!(
                    "HTTP/1.1 {status}\r\ncontent-length: {}\r\nconnection: close\r\n\r\n",
                    part.len()
                );
                let _ = socket.write_all(head.as_bytes()).await;
                let _ = socket.write_all(part).await;
            });
        }
    });
    format!("http://{address}/model.gguf")
}

fn client() -> reqwest::Client {
    fetch::client(
        Arc::new(Open),
        AllowedHosts::parse(&["127.0.0.1"]).unwrap(),
        "http",
    )
    .unwrap()
}

#[tokio::test]
async fn a_download_is_checked_and_resumed() {
    let body: Vec<u8> = (0..200_000u32).map(|n| (n % 251) as u8).collect();
    let url = serve(body.clone()).await;
    let folder = std::env::temp_dir().join(format!("nexo-local-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&folder).unwrap();
    let target = folder.join("model.gguf");
    let seen = std::sync::Mutex::new(0u64);
    fetch::fetch(
        &client(),
        &url,
        &target,
        body.len() as u64,
        &sha(&body),
        |n| *seen.lock().unwrap() = n,
    )
    .await
    .unwrap();
    assert_eq!(std::fs::read(&target).unwrap(), body);
    assert_eq!(*seen.lock().unwrap(), body.len() as u64);

    // A part left by an earlier try is continued.
    let again = folder.join("again.gguf");
    std::fs::write(folder.join("again.part"), &body[..50_000]).unwrap();
    fetch::fetch(
        &client(),
        &url,
        &again,
        body.len() as u64,
        &sha(&body),
        |_| {},
    )
    .await
    .unwrap();
    assert_eq!(std::fs::read(&again).unwrap(), body);

    // Another hash or size: refused and nothing kept.
    let wrong = folder.join("wrong.gguf");
    let refused = fetch::fetch(
        &client(),
        &url,
        &wrong,
        body.len() as u64,
        &"0".repeat(64),
        |_| {},
    )
    .await;
    assert!(refused.unwrap_err().to_string().contains("does not match"));
    assert!(!wrong.exists() && !folder.join("wrong.part").exists());
    let small = fetch::fetch(&client(), &url, &wrong, 10, &sha(&body), |_| {}).await;
    assert!(small.unwrap_err().to_string().contains("larger"));
    // A host the catalog does not name is never reached.
    let elsewhere = fetch::fetch(
        &client(),
        "http://localhost:9/x",
        &wrong,
        1,
        &sha(b""),
        |_| {},
    )
    .await;
    assert!(elsewhere.is_err());
    std::fs::remove_dir_all(folder).unwrap();
}
