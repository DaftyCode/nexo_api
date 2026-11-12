mod kafka;
mod socketio;

use super::*;
use tokio::net::TcpListener;

fn realtime() -> Realtime {
    Realtime::new(Policy::AllowAll, Arc::new(Vec::new))
}
async fn wait_for(realtime: &Realtime, id: &str, check: impl Fn(&Value) -> bool) -> Value {
    for _ in 0..200 {
        let polled = realtime.poll(&json!({"id": id})).unwrap();
        if check(&polled) {
            return polled;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    panic!(
        "condition not reached: {}",
        realtime.poll(&json!({"id": id})).unwrap()
    );
}

#[tokio::test]
async fn websocket_echo_and_close() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    tokio::spawn(async move {
        let (stream, _) = listener.accept().await.unwrap();
        let mut socket = tokio_tungstenite::accept_hdr_async(
            stream,
            |request: &tokio_tungstenite::tungstenite::handshake::server::Request, response| {
                assert_eq!(request.headers()["x-test"], "1");
                Ok(response)
            },
        )
        .await
        .unwrap();
        while let Some(Ok(message)) = socket.next().await {
            if message.is_text() {
                socket
                    .send(Message::text(format!(
                        "echo:{}",
                        message.to_text().unwrap()
                    )))
                    .await
                    .unwrap();
                socket.send(Message::binary(vec![1u8, 2])).await.unwrap();
                socket.close(None).await.unwrap();
            }
        }
    });
    let realtime = realtime();
    let connected = realtime
        .connect(&json!({"protocol": "websocket", "url": format!("ws://{address}"), "headers": [{"key": "x-test", "value": "1"}]}))
        .await
        .unwrap();
    let id = connected["id"].as_str().unwrap();
    wait_for(&realtime, id, |p| p["state"] == "connected").await;
    realtime.send(&json!({"id": id, "message": "hi"})).unwrap();
    let polled = wait_for(&realtime, id, |p| p["state"] == "closed").await;
    let events = polled["events"].as_array().unwrap();
    assert_eq!(
        events[1]["data"],
        json!({"text": "echo:hi", "binary": false})
    );
    assert_eq!(events[2]["data"], json!({"text": "AQI=", "binary": true}));
    assert_eq!(events[3]["type"], "close");
    let later = realtime.poll(&json!({"id": id, "after": 3})).unwrap();
    assert_eq!(later["events"].as_array().unwrap().len(), 1);
    assert_eq!(realtime.list().as_array().unwrap().len(), 1);
    realtime.disconnect(&json!({"id": id})).unwrap();
    assert!(realtime.poll(&json!({"id": id})).is_err());
}

#[test]
fn credentials_come_from_the_vault_for_their_hosts() {
    let payload = json!({"url": "mqtt://broker.example.com", "username": "u", "password": "{{vault:mqtt}}",
        "resolvedSecrets": {"mqtt": "s3cret"}, "secretHosts": {"mqtt": ["*.example.com"]}});
    assert_eq!(with_credentials(&payload).unwrap()["password"], "s3cret");
    let mut elsewhere = payload.clone();
    elsewhere["url"] = json!("mqtt://evil.test");
    assert!(
        with_credentials(&elsewhere)
            .unwrap_err()
            .to_string()
            .contains("Secret mqtt cannot be sent to evil.test")
    );
    let plain = json!({"url": "mqtt://x", "password": "literal"});
    assert_eq!(with_credentials(&plain).unwrap(), plain);
}

#[tokio::test]
async fn rejects_bad_protocols_and_blocked_destinations() {
    let realtime = realtime();
    assert!(
        realtime
            .connect(&json!({"protocol": "ftp", "url": "ftp://x"}))
            .await
            .is_err()
    );
    assert!(
        realtime
            .connect(&json!({"protocol": "websocket", "url": "http://x"}))
            .await
            .is_err()
    );
    let blocked = Realtime::new(
        Policy::parse(Some("deny-private"), None),
        Arc::new(Vec::new),
    );
    assert!(
        blocked
            .connect(&json!({"protocol": "websocket", "url": "ws://127.0.0.1:9"}))
            .await
            .is_err()
    );
}
