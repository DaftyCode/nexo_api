//! A Socket.IO connection over long polling and WebSocket.
use super::*;
use crate::realtime::*;

#[tokio::test]
async fn socketio_handshake_events_and_emit() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    tokio::spawn(async move {
        let (stream, _) = listener.accept().await.unwrap();
        let mut socket = tokio_tungstenite::accept_hdr_async(
            stream,
            |request: &tokio_tungstenite::tungstenite::handshake::server::Request, response| {
                assert_eq!(request.uri().path(), "/socket.io/");
                assert!(request.uri().query().unwrap().contains("EIO=4"));
                Ok(response)
            },
        )
        .await
        .unwrap();
        socket
            .send(Message::text(
                "0{\"sid\":\"e\",\"pingInterval\":25000,\"pingTimeout\":20000}",
            ))
            .await
            .unwrap();
        while let Some(Ok(message)) = socket.next().await {
            let text = message.to_text().unwrap().to_string();
            if text == "40{\"token\":\"t\"}" {
                socket
                    .send(Message::text("40{\"sid\":\"s1\"}"))
                    .await
                    .unwrap();
                socket.send(Message::text("2")).await.unwrap();
                socket
                    .send(Message::text("42[\"welcome\",{\"a\":1}]"))
                    .await
                    .unwrap();
            } else if let Some(packet) = text.strip_prefix("42") {
                socket
                    .send(Message::text(format!("42[\"echo\",{packet}]")))
                    .await
                    .unwrap();
            } else if text == "3" {
                socket.send(Message::text("42[\"pong\"]")).await.unwrap();
            }
        }
    });
    let realtime = realtime();
    let connected = realtime
        .connect(&json!({"protocol": "socketio", "url": format!("http://{address}"), "auth": {"token": "t"}, "transports": "websocket"}))
        .await
        .unwrap();
    let id = connected["id"].as_str().unwrap();
    let polled = wait_for(&realtime, id, |p| {
        p["events"].as_array().unwrap().len() >= 4
    })
    .await;
    assert_eq!(polled["events"][0]["data"], "s1");
    assert_eq!(polled["events"][1]["type"], "transport");
    assert_eq!(polled["events"][1]["data"], "websocket");
    realtime
        .send(&json!({"id": id, "event": "say", "message": "{\"b\":2}"}))
        .unwrap();
    let polled = wait_for(&realtime, id, |p| {
        p["events"].as_array().unwrap().len() >= 5
    })
    .await;
    let data: Vec<Value> = polled["events"]
        .as_array()
        .unwrap()
        .iter()
        .map(|e| e["data"].clone())
        .collect();
    assert!(
        data.contains(&json!({"event": "welcome", "data": [{"a": 1}]})),
        "{data:?}"
    );
    assert!(
        data.contains(&json!({"event": "pong", "data": []})),
        "{data:?}"
    );
    assert!(
        data.contains(&json!({"event": "echo", "data": [["say", {"b": 2}]]})),
        "{data:?}"
    );
    realtime.disconnect(&json!({"id": id})).unwrap();
}
