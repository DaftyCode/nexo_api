use super::*;
use serde_json::json;

fn event(name: &str, data: Value) -> Event {
    Event {
        name: name.into(),
        data: data.to_string(),
    }
}

#[test]
fn anthropic_events_become_text_stop_and_usage() {
    let start = event(
        "message_start",
        json!({"type": "message_start", "message": {"usage": {"input_tokens": 12, "output_tokens": 1}}}),
    );
    assert_eq!(
        deltas(Provider::Anthropic, &start),
        [Delta::Usage {
            input: 12,
            output: 1
        }]
    );
    let text = event(
        "content_block_delta",
        json!({"type": "content_block_delta", "delta": {"type": "text_delta", "text": "Hola"}}),
    );
    assert_eq!(
        deltas(Provider::Anthropic, &text),
        [Delta::Text("Hola".into())]
    );
    let thinking = event(
        "content_block_delta",
        json!({"type": "content_block_delta", "delta": {"type": "thinking_delta", "thinking": "…"}}),
    );
    assert!(deltas(Provider::Anthropic, &thinking).is_empty());
    let stop = event(
        "message_delta",
        json!({"type": "message_delta", "delta": {"stop_reason": "refusal"}, "usage": {"output_tokens": 30}}),
    );
    assert_eq!(
        deltas(Provider::Anthropic, &stop),
        [
            Delta::Stop("refusal".into()),
            Delta::Usage {
                input: 0,
                output: 30
            }
        ]
    );
    let failed = event(
        "error",
        json!({"type": "error", "error": {"type": "overloaded_error", "message": "Overloaded"}}),
    );
    assert_eq!(
        deltas(Provider::Anthropic, &failed),
        [Delta::Failed("Overloaded".into())]
    );
    assert!(
        deltas(
            Provider::Anthropic,
            &Event {
                name: "ping".into(),
                data: "not json".into()
            }
        )
        .is_empty()
    );
}

#[test]
fn openai_and_gemini_chunks_become_text_stop_and_usage() {
    let chunk = event(
        "message",
        json!({"choices": [{"delta": {"content": "Hi"}, "finish_reason": null}]}),
    );
    assert_eq!(deltas(Provider::Openai, &chunk), [Delta::Text("Hi".into())]);
    let last = event(
        "message",
        json!({"choices": [{"delta": {}, "finish_reason": "stop"}], "usage": {"prompt_tokens": 5, "completion_tokens": 7}}),
    );
    assert_eq!(
        deltas(Provider::Compatible, &last),
        [
            Delta::Stop("stop".into()),
            Delta::Usage {
                input: 5,
                output: 7
            }
        ]
    );
    assert!(
        deltas(
            Provider::Openai,
            &Event {
                name: "message".into(),
                data: "[DONE]".into()
            }
        )
        .is_empty()
    );
    let error = event("message", json!({"error": {"message": "bad model"}}));
    assert_eq!(
        deltas(Provider::Openai, &error),
        [Delta::Failed("bad model".into())]
    );
    let gemini = event(
        "message",
        json!({
            "candidates": [{"content": {"parts": [{"text": "plan", "thought": true}, {"text": "Hello"}]}, "finishReason": "STOP"}],
            "usageMetadata": {"promptTokenCount": 3, "candidatesTokenCount": 4}
        }),
    );
    assert_eq!(
        deltas(Provider::Gemini, &gemini),
        [
            Delta::Text("Hello".into()),
            Delta::Stop("stop".into()),
            Delta::Usage {
                input: 3,
                output: 4
            }
        ]
    );
    let gemini_error = event("message", json!({"error": {"message": "quota"}}));
    assert_eq!(
        deltas(Provider::Gemini, &gemini_error),
        [Delta::Failed("quota".into())]
    );
}
