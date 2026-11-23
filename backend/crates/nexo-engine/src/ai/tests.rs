//! The assistant against a provider played on loopback: an answer streamed and read by
//! polls, stopped halfway, refused, and the list of models.
use super::*;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
    sync::oneshot,
};

/// A provider that answers one request with `status`, `body` (sent in `parts`, with a pause
/// between them) and hands back the request it read.
async fn provider(
    status: u16,
    parts: Vec<String>,
    pause: u64,
) -> (String, oneshot::Receiver<String>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let (sender, receiver) = oneshot::channel();
    tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let mut request = Vec::new();
        let mut buffer = [0u8; 8192];
        loop {
            let read = socket.read(&mut buffer).await.unwrap();
            request.extend_from_slice(&buffer[..read]);
            let text = String::from_utf8_lossy(&request).to_string();
            if let Some(end) = text.find("\r\n\r\n") {
                let length = text
                    .lines()
                    .find_map(|line| {
                        line.to_ascii_lowercase()
                            .strip_prefix("content-length:")
                            .map(|n| n.trim().parse::<usize>().unwrap_or(0))
                    })
                    .unwrap_or(0);
                if request.len() >= end + 4 + length || read == 0 {
                    break;
                }
            }
            if read == 0 {
                break;
            }
        }
        let _ = sender.send(String::from_utf8_lossy(&request).to_string());
        let kind = if status == 200 {
            "text/event-stream"
        } else {
            "application/json"
        };
        let head = format!(
            "HTTP/1.1 {status} X\r\ncontent-type: {kind}\r\nretry-after: 7\r\nconnection: close\r\n\r\n"
        );
        socket.write_all(head.as_bytes()).await.unwrap();
        for part in parts {
            if socket.write_all(part.as_bytes()).await.is_err() {
                return;
            }
            let _ = socket.flush().await;
            tokio::time::sleep(Duration::from_millis(pause)).await;
        }
    });
    (format!("http://{address}/v1"), receiver)
}

fn assistant() -> Assistant {
    Assistant::new(Policy::AllowAll, Arc::new(Vec::new))
}

fn chat(base: &str, provider: &str) -> Value {
    json!({
        "provider": provider,
        "baseUrl": base,
        "model": "claude-opus-5-5",
        "resolvedKey": "sk-test-key",
        "system": "Be brief",
        "messages": [{"role": "user", "text": "Hola"}],
    })
}

async fn finished(assistant: &Assistant, id: &str) -> (String, Value) {
    let mut text = String::new();
    let mut after = 0;
    for _ in 0..200 {
        let polled = assistant.poll(&json!({"id": id, "after": after})).unwrap();
        text.push_str(polled["text"].as_str().unwrap());
        after = polled["next"].as_u64().unwrap();
        if polled["done"] == true {
            return (text, polled);
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    panic!("the answer never ended");
}

fn sse(event: &str, data: Value) -> String {
    format!("event: {event}\ndata: {data}\n\n")
}

#[tokio::test]
async fn an_answer_streams_and_is_read_by_polls() {
    let parts = vec![
        sse(
            "message_start",
            json!({"type": "message_start", "message": {"usage": {"input_tokens": 9, "output_tokens": 1}}}),
        ),
        sse(
            "content_block_delta",
            json!({"type": "content_block_delta", "delta": {"type": "text_delta", "text": "Hola, "}}),
        ),
        sse(
            "content_block_delta",
            json!({"type": "content_block_delta", "delta": {"type": "text_delta", "text": "¿qué tal?"}}),
        ),
        // The last event without the blank line that should end it.
        format!(
            "event: message_delta\ndata: {}",
            json!({"type": "message_delta", "delta": {"stop_reason": "end_turn"}, "usage": {"output_tokens": 6}})
        ),
    ];
    let (base, request) = provider(200, parts, 10).await;
    let assistant = assistant();
    let started = assistant.start(&chat(&base, "anthropic")).await.unwrap();
    let id = started["id"].as_str().unwrap();
    let (text, last) = finished(&assistant, id).await;
    assert_eq!(text, "Hola, ¿qué tal?");
    assert_eq!(last["stop"], "end_turn");
    assert_eq!(last["usage"], json!({"input": 9, "output": 6}));
    assert!(last["error"].is_null());
    let request = request.await.unwrap();
    assert!(request.starts_with("POST /v1/messages "));
    assert!(
        request
            .to_ascii_lowercase()
            .contains("x-api-key: sk-test-key")
    );
    assert!(request.contains("\"system\":\"Be brief\""));
    // An ended answer is read once.
    assert!(assistant.poll(&json!({"id": id})).is_err());
}

#[tokio::test]
async fn an_answer_stops_where_it_is() {
    let chunk = |text: &str| {
        sse(
            "message",
            json!({"choices": [{"delta": {"content": text}}]}),
        )
    };
    let parts = vec![chunk("One"), chunk("Two"), chunk("Three"), chunk("Four")];
    let (base, _) = provider(200, parts, 400).await;
    let assistant = assistant();
    let started = assistant.start(&chat(&base, "openai")).await.unwrap();
    let id = started["id"].as_str().unwrap().to_owned();
    tokio::time::sleep(Duration::from_millis(150)).await;
    assert_eq!(assistant.stop(&json!({"id": id})).unwrap()["stopped"], true);
    let (text, last) = finished(&assistant, &id).await;
    assert_eq!(text, "One");
    assert_eq!(last["stop"], "stopped");
    assert_eq!(
        assistant.stop(&json!({"id": "gone"})).unwrap()["stopped"],
        false
    );
    assistant.close();
}

#[tokio::test]
async fn a_refused_key_says_why() {
    let body = json!({"type": "error", "error": {"type": "authentication_error", "message": "invalid x-api-key"}});
    let (base, _) = provider(401, vec![body.to_string()], 0).await;
    let assistant = assistant();
    let started = assistant.start(&chat(&base, "anthropic")).await.unwrap();
    let (text, last) = finished(&assistant, started["id"].as_str().unwrap()).await;
    assert_eq!(text, "");
    assert!(
        last["error"]
            .as_str()
            .unwrap()
            .contains("refused the API key")
    );
    let (base, _) = provider(
        200,
        vec![sse("message", json!({"error": {"message": "bad model"}}))],
        0,
    )
    .await;
    let started = assistant.start(&chat(&base, "compatible")).await.unwrap();
    let (_, last) = finished(&assistant, started["id"].as_str().unwrap()).await;
    assert_eq!(last["error"], "bad model");
}

#[tokio::test]
async fn nothing_is_sent_without_a_key_or_a_question() {
    let assistant = assistant();
    let mut keyless = chat("http://127.0.0.1:9/v1", "anthropic");
    keyless["resolvedKey"] = Value::Null;
    assert!(assistant.start(&keyless).await.is_err());
    let mut empty = chat("http://127.0.0.1:9/v1", "openai");
    empty["messages"] = json!([]);
    assert!(assistant.start(&empty).await.is_err());
    let mut broken = chat("http://127.0.0.1:9/v1", "openai");
    broken["messages"] = json!("text");
    assert!(assistant.start(&broken).await.is_err());
    assert!(
        assistant
            .models(&json!({"provider": "other"}))
            .await
            .is_err()
    );
}

#[tokio::test]
async fn the_models_of_a_provider_are_listed() {
    let body = json!({"data": [{"id": "gpt-a"}, {"id": "gpt-b"}, {"id": "gpt-a"}]});
    let (base, request) = provider(200, vec![body.to_string()], 0).await;
    let listed = assistant()
        .models(&json!({"provider": "openai", "baseUrl": base, "resolvedKey": "sk-k"}))
        .await
        .unwrap();
    assert_eq!(
        listed["models"],
        json!([{"id": "gpt-a", "name": ""}, {"id": "gpt-b", "name": ""}])
    );
    let request = request.await.unwrap();
    assert!(request.starts_with("GET /v1/models "));
    assert!(
        request
            .to_ascii_lowercase()
            .contains("authorization: bearer sk-k")
    );
    let (base, _) = provider(500, vec!["{}".into()], 0).await;
    let failed = assistant()
        .models(&json!({"provider": "compatible", "baseUrl": base}))
        .await
        .unwrap_err();
    assert!(failed.to_string().contains("failed"));
    let (base, _) = provider(200, vec!["not json".into()], 0).await;
    assert!(
        assistant()
            .models(&json!({"provider": "compatible", "baseUrl": base}))
            .await
            .is_err()
    );
}
