//! One turn of the model put together from its stream, as the provider gave it, to send back
//! unchanged when tools continue it: Anthropic's content blocks with their thinking and its
//! signature, OpenAI's text and `tool_calls`, Gemini's parts with their thought signatures.
//! Sending the thinking back as it came is what Claude and Gemini ask of a turn with tools.
use super::tools::{OWN_ID, ToolCall};
use nexo_domain::ai::Provider;
use serde_json::{Map, Value, json};

/// Characters of a turn kept at most; a longer turn is cut, its tools still read.
const MAX_TURN: usize = 2 << 20;

/// A turn as it arrives.
#[derive(Debug, Default)]
pub struct Turn {
    /// Anthropic's content blocks by index, Gemini's parts in order.
    blocks: Vec<Value>,
    /// The JSON of each Anthropic tool's input, as it streams.
    inputs: Vec<String>,
    /// OpenAI's text, and its calls by index: id, name and arguments.
    text: String,
    calls: Vec<(String, String, String)>,
    size: usize,
}

fn append(target: &mut Value, field: &str, piece: &str) {
    let mut joined = target[field].as_str().unwrap_or_default().to_owned();
    joined.push_str(piece);
    target[field] = Value::String(joined);
}

impl Turn {
    fn slot<T: Default>(items: &mut Vec<T>, index: usize) -> &mut T {
        if items.len() <= index {
            items.resize_with(index + 1, T::default);
        }
        &mut items[index]
    }

    /// Takes in one event of the stream.
    pub fn push(&mut self, provider: Provider, data: &Value) {
        self.size += data.to_string().len();
        if self.size > MAX_TURN {
            return;
        }
        match provider {
            Provider::Anthropic => self.anthropic(data),
            Provider::Openai | Provider::Compatible | Provider::Local => {
                let delta = &data["choices"][0]["delta"];
                if let Some(text) = delta["content"].as_str() {
                    self.text.push_str(text);
                }
                for call in delta["tool_calls"].as_array().into_iter().flatten() {
                    let index = call["index"].as_u64().unwrap_or(0) as usize;
                    let (id, name, arguments) = Self::slot(&mut self.calls, index.min(63));
                    if let Some(given) = call["id"].as_str() {
                        *id = given.into();
                    }
                    if let Some(given) = call["function"]["name"].as_str() {
                        name.push_str(given);
                    }
                    if let Some(piece) = call["function"]["arguments"].as_str() {
                        arguments.push_str(piece);
                    }
                }
            }
            Provider::Gemini => {
                let parts = data["candidates"][0]["content"]["parts"].as_array();
                self.blocks.extend(parts.into_iter().flatten().cloned());
            }
        }
    }

    fn anthropic(&mut self, data: &Value) {
        let index = (data["index"].as_u64().unwrap_or(0) as usize).min(255);
        match data["type"].as_str().unwrap_or_default() {
            "content_block_start" => {
                *Self::slot(&mut self.blocks, index) = data["content_block"].clone();
            }
            "content_block_delta" => {
                let delta = &data["delta"];
                let piece = |field: &str| delta[field].as_str().unwrap_or_default();
                match delta["type"].as_str().unwrap_or_default() {
                    "text_delta" => {
                        append(Self::slot(&mut self.blocks, index), "text", piece("text"))
                    }
                    "thinking_delta" => append(
                        Self::slot(&mut self.blocks, index),
                        "thinking",
                        piece("thinking"),
                    ),
                    "signature_delta" => append(
                        Self::slot(&mut self.blocks, index),
                        "signature",
                        piece("signature"),
                    ),
                    "input_json_delta" => {
                        Self::slot(&mut self.inputs, index).push_str(piece("partial_json"))
                    }
                    _ => {}
                }
            }
            _ => {}
        }
    }

    /// The turn to send back, and the tools it asked for.
    pub fn finish(self, provider: Provider) -> (Value, Vec<ToolCall>) {
        let input = |text: &str| match text.trim() {
            "" => json!({}),
            text => serde_json::from_str(text).unwrap_or_else(|_| Value::String(text.into())),
        };
        match provider {
            Provider::Anthropic => {
                let mut calls = Vec::new();
                let mut blocks = Vec::new();
                for (index, mut block) in self.blocks.into_iter().enumerate() {
                    if block.is_null() {
                        continue;
                    }
                    if block["type"] == "tool_use" {
                        let given = self.inputs.get(index).map(String::as_str).unwrap_or("");
                        if !given.is_empty() || !block["input"].is_object() {
                            block["input"] = input(given);
                        }
                        calls.push(ToolCall {
                            id: block["id"].as_str().unwrap_or_default().into(),
                            name: block["name"].as_str().unwrap_or_default().into(),
                            input: block["input"].clone(),
                        });
                    }
                    blocks.push(block);
                }
                (json!({"role": "assistant", "content": blocks}), calls)
            }
            Provider::Openai | Provider::Compatible | Provider::Local => {
                let calls: Vec<ToolCall> = self
                    .calls
                    .into_iter()
                    .enumerate()
                    .filter(|(_, (_, name, _))| !name.is_empty())
                    .map(|(index, (id, name, arguments))| ToolCall {
                        id: if id.is_empty() {
                            format!("{OWN_ID}{index}")
                        } else {
                            id
                        },
                        input: input(&arguments),
                        name,
                    })
                    .collect();
                let mut native = json!({"role": "assistant", "content": self.text});
                if !calls.is_empty() {
                    native["tool_calls"] = calls
                        .iter()
                        .map(|call| json!({"id": call.id, "type": "function", "function": {
                            "name": call.name,
                            "arguments": match &call.input { Value::String(raw) => raw.clone(), other => other.to_string() }}}))
                        .collect();
                }
                (native, calls)
            }
            Provider::Gemini => {
                let parts = merged(self.blocks);
                let calls = parts
                    .iter()
                    .filter(|part| part["functionCall"].is_object())
                    .enumerate()
                    .map(|(index, part)| {
                        let call = &part["functionCall"];
                        ToolCall {
                            id: call["id"]
                                .as_str()
                                .map_or_else(|| format!("{OWN_ID}{index}"), String::from),
                            name: call["name"].as_str().unwrap_or_default().into(),
                            input: if call["args"].is_object() {
                                call["args"].clone()
                            } else {
                                json!({})
                            },
                        }
                    })
                    .collect();
                (json!({"role": "model", "parts": parts}), calls)
            }
        }
    }
}

/// Gemini's parts with the pieces of one text joined: a text part continues the one before
/// when both are plain text of the same kind and it brings no signature of its own.
fn merged(parts: Vec<Value>) -> Vec<Value> {
    let plain = |part: &Map<String, Value>| {
        part.keys()
            .all(|key| matches!(key.as_str(), "text" | "thought" | "thoughtSignature"))
            && part.contains_key("text")
    };
    let mut joined: Vec<Value> = Vec::new();
    for part in parts {
        let continues = match (joined.last(), &part) {
            (Some(Value::Object(previous)), Value::Object(next)) => {
                plain(previous)
                    && plain(next)
                    && !next.contains_key("thoughtSignature")
                    && previous.get("thought") == next.get("thought")
            }
            _ => false,
        };
        match joined.last_mut() {
            Some(last) if continues => {
                append(last, "text", part["text"].as_str().unwrap_or_default())
            }
            _ => joined.push(part),
        }
    }
    joined
}

#[cfg(test)]
mod tests;
