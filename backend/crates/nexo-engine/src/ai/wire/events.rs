//! What each event of a provider's stream brings to the answer.
use crate::graphql_sse::Event;
use nexo_domain::ai::Provider;
use serde_json::Value;

/// What an event of a stream brings to the answer.
#[derive(Debug, Clone, PartialEq)]
pub enum Delta {
    Text(String),
    /// What the model reasons before it answers, as far as the provider shows it.
    Thinking(String),
    /// Why the answer ended: `end_turn`, `max_tokens`, `refusal`, `stop`, `length`…
    Stop(String),
    /// Tokens read and written, as the provider counts them.
    Usage {
        input: u64,
        output: u64,
    },
    /// The answer failed while it was written.
    Failed(String),
}

fn usage(input: &Value, output: &Value) -> Option<Delta> {
    let (input, output) = (input.as_u64(), output.as_u64());
    (input.is_some() || output.is_some()).then(|| Delta::Usage {
        input: input.unwrap_or_default(),
        output: output.unwrap_or_default(),
    })
}

/// A piece of reasoning, when there is one.
fn thought(value: &Value) -> Option<Delta> {
    value
        .as_str()
        .filter(|text| !text.is_empty())
        .map(|text| Delta::Thinking(text.into()))
}

/// The deltas of one event of a stream.
pub fn deltas(provider: Provider, event: &Event) -> Vec<Delta> {
    if event.data.trim() == "[DONE]" {
        return Vec::new();
    }
    let Ok(data) = serde_json::from_str::<Value>(&event.data) else {
        return Vec::new();
    };
    let mut found = Vec::new();
    match provider {
        Provider::Anthropic => match data["type"].as_str().unwrap_or(&event.name) {
            "content_block_delta" if data["delta"]["type"] == "text_delta" => {
                found.push(Delta::Text(
                    data["delta"]["text"].as_str().unwrap_or_default().into(),
                ));
            }
            "content_block_delta" if data["delta"]["type"] == "thinking_delta" => {
                found.extend(thought(&data["delta"]["thinking"]));
            }
            "message_start" => found.extend(usage(
                &data["message"]["usage"]["input_tokens"],
                &data["message"]["usage"]["output_tokens"],
            )),
            "message_delta" => {
                if let Some(stop) = data["delta"]["stop_reason"].as_str() {
                    found.push(Delta::Stop(stop.into()));
                }
                found.extend(usage(
                    &data["usage"]["input_tokens"],
                    &data["usage"]["output_tokens"],
                ));
            }
            "error" => found.push(Delta::Failed(
                data["error"]["message"]
                    .as_str()
                    .unwrap_or("The answer failed")
                    .into(),
            )),
            _ => {}
        },
        Provider::Openai | Provider::Compatible | Provider::Local => {
            if let Some(error) = data["error"]["message"].as_str() {
                found.push(Delta::Failed(error.into()));
            }
            for choice in data["choices"].as_array().into_iter().flatten() {
                // llama.cpp and vLLM name it `reasoning_content`; others `reasoning`.
                found.extend(thought(&choice["delta"]["reasoning_content"]));
                found.extend(thought(&choice["delta"]["reasoning"]));
                if let Some(text) = choice["delta"]["content"].as_str() {
                    found.push(Delta::Text(text.into()));
                }
                if let Some(stop) = choice["finish_reason"].as_str() {
                    found.push(Delta::Stop(stop.into()));
                }
            }
            found.extend(usage(
                &data["usage"]["prompt_tokens"],
                &data["usage"]["completion_tokens"],
            ));
        }
        Provider::Gemini => {
            for candidate in data["candidates"].as_array().into_iter().flatten() {
                for part in candidate["content"]["parts"]
                    .as_array()
                    .into_iter()
                    .flatten()
                {
                    // Thoughts are shown apart from the answer.
                    if part["thought"] == true {
                        found.extend(thought(&part["text"]));
                    } else if let Some(text) = part["text"].as_str() {
                        found.push(Delta::Text(text.into()));
                    }
                }
                if let Some(stop) = candidate["finishReason"].as_str() {
                    found.push(Delta::Stop(stop.to_ascii_lowercase()));
                }
            }
            found.extend(usage(
                &data["usageMetadata"]["promptTokenCount"],
                &data["usageMetadata"]["candidatesTokenCount"],
            ));
            if let Some(error) = data["error"]["message"].as_str() {
                found.push(Delta::Failed(error.into()));
            }
        }
    }
    found
}

#[cfg(test)]
mod tests;
