use super::*;

fn turn(provider: Provider, events: &[Value]) -> (Value, Vec<ToolCall>) {
    let mut turn = Turn::default();
    for event in events {
        turn.push(provider, event);
    }
    turn.finish(provider)
}

#[test]
fn claude_keeps_its_thinking_with_its_signature_and_its_tools() {
    let (native, calls) = turn(
        Provider::Anthropic,
        &[
            json!({"type": "message_start", "message": {"usage": {}}}),
            json!({"type": "content_block_start", "index": 0, "content_block": {"type": "thinking", "thinking": "", "signature": ""}}),
            json!({"type": "content_block_delta", "index": 0, "delta": {"type": "thinking_delta", "thinking": "Read "}}),
            json!({"type": "content_block_delta", "index": 0, "delta": {"type": "thinking_delta", "thinking": "it."}}),
            json!({"type": "content_block_delta", "index": 0, "delta": {"type": "signature_delta", "signature": "sig-1"}}),
            json!({"type": "content_block_stop", "index": 0}),
            json!({"type": "content_block_start", "index": 1, "content_block": {"type": "text", "text": ""}}),
            json!({"type": "content_block_delta", "index": 1, "delta": {"type": "text_delta", "text": "Let me look."}}),
            json!({"type": "content_block_start", "index": 2, "content_block": {"type": "tool_use", "id": "toolu_1", "name": "sql_query", "input": {}}}),
            json!({"type": "content_block_delta", "index": 2, "delta": {"type": "input_json_delta", "partial_json": "{\"sql\": "}}),
            json!({"type": "content_block_delta", "index": 2, "delta": {"type": "input_json_delta", "partial_json": "\"SELECT 1\"}"}}),
            json!({"type": "content_block_start", "index": 3, "content_block": {"type": "tool_use", "id": "toolu_2", "name": "read_open", "input": {}}}),
            json!({"type": "message_delta", "delta": {"stop_reason": "tool_use"}}),
        ],
    );
    assert_eq!(
        native,
        json!({"role": "assistant", "content": [
            {"type": "thinking", "thinking": "Read it.", "signature": "sig-1"},
            {"type": "text", "text": "Let me look."},
            {"type": "tool_use", "id": "toolu_1", "name": "sql_query", "input": {"sql": "SELECT 1"}},
            {"type": "tool_use", "id": "toolu_2", "name": "read_open", "input": {}},
        ]})
    );
    assert_eq!(
        calls,
        [
            ToolCall {
                id: "toolu_1".into(),
                name: "sql_query".into(),
                input: json!({"sql": "SELECT 1"})
            },
            ToolCall {
                id: "toolu_2".into(),
                name: "read_open".into(),
                input: json!({})
            },
        ]
    );
}

#[test]
fn openai_calls_are_joined_by_index_and_named_when_the_server_gives_no_id() {
    let chunk = |delta: Value| json!({"choices": [{"index": 0, "delta": delta}]});
    let (native, calls) = turn(
        Provider::Local,
        &[
            chunk(json!({"reasoning_content": "Plan"})),
            chunk(json!({"content": "Checking"})),
            chunk(
                json!({"tool_calls": [{"index": 0, "id": "call_1", "type": "function", "function": {"name": "sql_query", "arguments": ""}}]}),
            ),
            chunk(json!({"tool_calls": [{"index": 0, "function": {"arguments": "{\"sql\":"}}]})),
            chunk(
                json!({"tool_calls": [{"index": 0, "function": {"arguments": "\"SELECT 1\"}"}}]}),
            ),
            chunk(
                json!({"tool_calls": [{"index": 1, "function": {"name": "read_open", "arguments": "not json"}}]}),
            ),
            json!({"choices": [{"index": 0, "delta": {}, "finish_reason": "tool_calls"}]}),
        ],
    );
    assert_eq!(native["content"], "Checking");
    assert_eq!(
        native["tool_calls"],
        json!([
            {"id": "call_1", "type": "function", "function": {"name": "sql_query", "arguments": "{\"sql\":\"SELECT 1\"}"}},
            {"id": "nexo-call-1", "type": "function", "function": {"name": "read_open", "arguments": "not json"}},
        ])
    );
    assert_eq!(calls[0].input, json!({"sql": "SELECT 1"}));
    // Arguments that are not JSON reach the tool as they came, to be refused there.
    assert_eq!(calls[1].input, json!("not json"));
    let (plain, none) = turn(Provider::Openai, &[chunk(json!({"content": "Hi"}))]);
    assert!(none.is_empty() && plain.get("tool_calls").is_none());
}

#[test]
fn gemini_keeps_its_parts_with_their_signatures_and_joins_its_text() {
    let parts =
        |parts: Value| json!({"candidates": [{"content": {"role": "model", "parts": parts}}]});
    let (native, calls) = turn(
        Provider::Gemini,
        &[
            parts(json!([{"text": "Hmm", "thought": true, "thoughtSignature": "s0"}])),
            parts(json!([{"text": " more", "thought": true}])),
            parts(json!([{"text": "Ok"}, {"text": "."}])),
            parts(
                json!([{"functionCall": {"name": "mongo_find", "args": {"filter": {}}}, "thoughtSignature": "s1"}]),
            ),
            parts(json!([{"functionCall": {"id": "g-2", "name": "read_open"}}])),
        ],
    );
    assert_eq!(
        native,
        json!({"role": "model", "parts": [
            {"text": "Hmm more", "thought": true, "thoughtSignature": "s0"},
            {"text": "Ok."},
            {"functionCall": {"name": "mongo_find", "args": {"filter": {}}}, "thoughtSignature": "s1"},
            {"functionCall": {"id": "g-2", "name": "read_open"}},
        ]})
    );
    assert_eq!(calls[0].id, "nexo-call-0");
    assert_eq!(calls[0].input, json!({"filter": {}}));
    assert_eq!((calls[1].id.as_str(), &calls[1].input), ("g-2", &json!({})));
}

#[test]
fn a_turn_too_long_stops_growing() {
    let mut turn = Turn::default();
    let big = "x".repeat(1 << 20);
    for _ in 0..4 {
        turn.push(
            Provider::Openai,
            &json!({"choices": [{"delta": {"content": big}}]}),
        );
    }
    let (native, _) = turn.finish(Provider::Openai);
    assert!(native["content"].as_str().unwrap().len() <= 2 << 20);
}
