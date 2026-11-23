//! An answer that reads with tools: the chat waits for them, their answers go back after
//! the model's turn as it gave it (thinking and signature included), and the answer goes on
//! in the same chat; a model that keeps asking is stopped, and so is a waiting answer.
use super::*;
use tokio::{io::AsyncWriteExt, net::TcpListener, sync::mpsc};

/// A provider that answers its requests in turn with `scripts` (the last one again and
/// again), and hands back each request it read.
async fn provider(scripts: Vec<Vec<String>>) -> (String, mpsc::UnboundedReceiver<String>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let (sender, receiver) = mpsc::unbounded_channel();
    tokio::spawn(async move {
        let mut turn = 0;
        while let Ok((mut socket, _)) = listener.accept().await {
            let request = read_request(&mut socket).await;
            let _ = sender.send(request);
            let script = &scripts[turn.min(scripts.len() - 1)];
            turn += 1;
            let head =
                "HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\nconnection: close\r\n\r\n";
            let _ = socket.write_all(head.as_bytes()).await;
            for part in script {
                let _ = socket.write_all(part.as_bytes()).await;
            }
        }
    });
    (format!("http://{address}/v1"), receiver)
}

fn sse(data: Value) -> String {
    format!(
        "event: {}\ndata: {data}\n\n",
        data["type"].as_str().unwrap()
    )
}

/// A turn that reasons, says a word and asks for `read_open`.
fn asks() -> Vec<String> {
    vec![
        sse(
            json!({"type": "content_block_start", "index": 0, "content_block": {"type": "thinking", "thinking": "", "signature": ""}}),
        ),
        sse(
            json!({"type": "content_block_delta", "index": 0, "delta": {"type": "thinking_delta", "thinking": "Read it."}}),
        ),
        sse(
            json!({"type": "content_block_delta", "index": 0, "delta": {"type": "signature_delta", "signature": "sig-1"}}),
        ),
        sse(
            json!({"type": "content_block_start", "index": 1, "content_block": {"type": "text", "text": ""}}),
        ),
        sse(
            json!({"type": "content_block_delta", "index": 1, "delta": {"type": "text_delta", "text": "Let me look."}}),
        ),
        sse(
            json!({"type": "content_block_start", "index": 2, "content_block": {"type": "tool_use", "id": "toolu_1", "name": "read_open", "input": {}}}),
        ),
        sse(json!({"type": "message_delta", "delta": {"stop_reason": "tool_use"}})),
    ]
}

fn chat_with_tools(base: &str) -> Value {
    let mut payload = chat(base, "anthropic");
    payload["tools"] = json!([{"name": "read_open", "description": "What is open"}]);
    payload
}

/// Polls until the answer waits for tools or ends.
async fn settled(assistant: &Assistant, id: &str) -> Value {
    for _ in 0..200 {
        let polled = assistant.poll(&json!({"id": id})).unwrap();
        if polled["done"] == true || polled["tools"].as_array().is_some_and(|t| !t.is_empty()) {
            return polled;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    panic!("the answer never settled");
}

#[tokio::test]
async fn an_answer_waits_for_its_tools_and_goes_on_after_them() {
    let answer = vec![
        sse(
            json!({"type": "content_block_delta", "index": 0, "delta": {"type": "thinking_delta", "thinking": "It is a count."}}),
        ),
        sse(
            json!({"type": "content_block_delta", "index": 1, "delta": {"type": "text_delta", "text": "It selects one."}}),
        ),
        sse(json!({"type": "message_delta", "delta": {"stop_reason": "end_turn"}})),
    ];
    let (base, mut requests) = provider(vec![asks(), answer]).await;
    let assistant = assistant();
    let started = assistant.start(&chat_with_tools(&base)).await.unwrap();
    let id = started["id"].as_str().unwrap();
    let waiting = settled(&assistant, id).await;
    assert_eq!(waiting["done"], false);
    assert_eq!(
        waiting["tools"],
        json!([{"id": "toolu_1", "name": "read_open", "input": {}}])
    );
    assert!(waiting["stop"].is_null());
    let first = requests.recv().await.unwrap();
    assert!(first.contains("\"input_schema\""), "{first}");
    // Only the answers of what it asked for are taken.
    assert!(
        assistant
            .resume(&json!({"id": id, "results": [{"id": "other", "text": "x"}]}))
            .is_err()
    );
    let resumed = assistant
        .resume(&json!({"id": id, "results": [{"id": "toolu_1", "text": "SELECT 1"}]}))
        .unwrap();
    assert_eq!(resumed["continued"], true);
    let (text, last) = finished(&assistant, id).await;
    assert_eq!(text, "Let me look.\n\nIt selects one.");
    assert_eq!(last["thinking"], "Read it.\n\nIt is a count.");
    assert_eq!(last["stop"], "end_turn");
    let second = requests.recv().await.unwrap();
    let body: Value =
        serde_json::from_str(&second[second.find("\r\n\r\n").unwrap() + 4..]).unwrap();
    // The turn goes back as Claude gave it, its thinking signed, before the tool's answer.
    assert_eq!(
        body["messages"][1]["content"][0],
        json!({"type": "thinking", "thinking": "Read it.", "signature": "sig-1"})
    );
    assert_eq!(body["messages"][1]["content"][2]["type"], "tool_use");
    assert_eq!(
        body["messages"][2],
        json!({"role": "user", "content": [{"type": "tool_result", "tool_use_id": "toolu_1", "content": "SELECT 1", "is_error": false}]})
    );
    assert!(assistant.resume(&json!({"id": id, "results": []})).is_err());
}

#[tokio::test]
async fn a_model_that_keeps_asking_is_stopped_and_a_waiting_answer_can_be_stopped() {
    let (base, _requests) = provider(vec![asks()]).await;
    let assistant = assistant();
    let started = assistant.start(&chat_with_tools(&base)).await.unwrap();
    let id = started["id"].as_str().unwrap().to_owned();
    let answer = json!({"id": id, "results": [{"id": "toolu_1", "text": ""}]});
    for _ in 0..resume::MAX_ROUNDS {
        settled(&assistant, &id).await;
        assert_eq!(assistant.resume(&answer).unwrap()["continued"], true);
    }
    settled(&assistant, &id).await;
    assert_eq!(assistant.resume(&answer).unwrap()["continued"], false);
    let (_, last) = finished(&assistant, &id).await;
    assert_eq!(last["stop"], "tools");

    let started = assistant.start(&chat_with_tools(&base)).await.unwrap();
    let id = started["id"].as_str().unwrap();
    settled(&assistant, id).await;
    assert_eq!(assistant.stop(&json!({"id": id})).unwrap()["stopped"], true);
    let (_, last) = finished(&assistant, id).await;
    assert_eq!(last["stop"], "stopped");
}
