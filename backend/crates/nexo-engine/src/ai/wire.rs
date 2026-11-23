//! What each provider's API asks and answers, without the network: the request of a chat
//! (Anthropic's Messages, OpenAI's Chat Completions, which compatible servers speak too, and
//! Gemini's `streamGenerateContent`) with the reasoning shown where the model gives it, the
//! meaning of each event of its stream, its list of models and its errors.
use nexo_domain::{
    Error, Result,
    ai::{Message, Provider, Role},
};
use serde_json::{Value, json};

/// The version of Anthropic's API.
pub const ANTHROPIC_VERSION: &str = "2026-10-21";
/// Anthropic's models that take server-side fallbacks after a refusal.
const FALLBACK_MODELS: [&str; 5] = [
    "claude-fable-5-2",
    "claude-fable-5-1",
    "claude-opus-5-5",
    "claude-opus-5",
    "claude-sonnet-5-5",
];
/// Tokens an answer may have.
const MAX_TOKENS: u64 = 64_000;

/// Who the assistant talks to, and how.
#[derive(Debug, Clone)]
pub struct Settings {
    pub provider: Provider,
    pub base: String,
    pub model: String,
    pub key: Option<String>,
    pub effort: Option<&'static str>,
}

/// A request to send: where, its headers and its JSON body (none for a `GET`).
#[derive(Debug, Clone, PartialEq)]
pub struct Call {
    pub url: String,
    pub headers: Vec<(String, String)>,
    pub body: Option<String>,
}

fn key_headers(settings: &Settings) -> Vec<(String, String)> {
    let key = settings.key.clone().unwrap_or_default();
    match settings.provider {
        Provider::Anthropic => vec![
            ("x-api-key".into(), key),
            ("anthropic-version".into(), ANTHROPIC_VERSION.into()),
        ],
        Provider::Gemini => vec![("x-goog-api-key".into(), key)],
        Provider::Openai | Provider::Compatible | Provider::Local if key.is_empty() => Vec::new(),
        Provider::Openai | Provider::Compatible | Provider::Local => {
            vec![("authorization".into(), format!("Bearer {key}"))]
        }
    }
}

fn role(role: Role, gemini: bool) -> &'static str {
    match role {
        Role::User => "user",
        Role::Assistant if gemini => "model",
        Role::Assistant => "assistant",
    }
}

/// A conversation in the provider's words.
pub fn native(provider: Provider, messages: &[Message]) -> Vec<Value> {
    messages
        .iter()
        .map(|message| match provider {
            Provider::Gemini => {
                json!({"role": role(message.role, true), "parts": [{"text": message.text}]})
            }
            _ => json!({"role": role(message.role, false), "content": message.text}),
        })
        .collect()
}

/// The streamed chat of `messages`, after the instructions `system`.
pub fn chat(settings: &Settings, messages: &[Message], system: &str) -> Result<Call> {
    request(settings, &native(settings.provider, messages), system, &[])
}

/// The streamed request of a conversation already in the provider's words, after the
/// instructions `system`, with the `tools` the model may ask for.
pub fn request(
    settings: &Settings,
    native: &[Value],
    system: &str,
    tools: &[Tool],
) -> Result<Call> {
    let mut headers = key_headers(settings);
    let offered = tools::definitions(settings.provider, tools);
    let (url, mut body) = match settings.provider {
        Provider::Anthropic => {
            let mut body = json!({
                "model": settings.model,
                "max_tokens": MAX_TOKENS,
                "stream": true,
                // The instructions, the tools and the conversation so far are read again
                // from the cache.
                "cache_control": {"type": "ephemeral"},
                "messages": native,
            });
            if !system.is_empty() {
                body["system"] = json!(system);
            }
            if let Some(effort) = settings.effort {
                body["output_config"] = json!({"effort": effort});
            }
            if thinking::anthropic_adaptive(&settings.model) {
                // A summary of its thinking streams before the answer, shown apart.
                body["thinking"] = json!({"type": "adaptive", "display": "summarized"});
            }
            if FALLBACK_MODELS.contains(&settings.model.as_str()) {
                // A model that declines answers through the one the API picks for the case.
                headers.push((
                    "anthropic-beta".into(),
                    "server-side-fallback-2026-07-01".into(),
                ));
                body["fallbacks"] = json!("default");
            }
            (format!("{}/messages", settings.base), body)
        }
        Provider::Openai | Provider::Compatible | Provider::Local => {
            let mut sent = Vec::new();
            if !system.is_empty() {
                sent.push(json!({"role": "system", "content": system}));
            }
            sent.extend(native.iter().cloned());
            let body = json!({
                "model": settings.model,
                "stream": true,
                "stream_options": {"include_usage": true},
                "messages": sent,
            });
            (format!("{}/chat/completions", settings.base), body)
        }
        Provider::Gemini => {
            let mut body = json!({"contents": native});
            if !system.is_empty() {
                body["systemInstruction"] = json!({"parts": [{"text": system}]});
            }
            if thinking::gemini_thinks(&settings.model) {
                body["generationConfig"] = json!({"thinkingConfig": {"includeThoughts": true}});
            }
            let model = settings.model.trim_start_matches("models/");
            (
                format!(
                    "{}/models/{}:streamGenerateContent?alt=sse",
                    settings.base,
                    encode(model)
                ),
                body,
            )
        }
    };
    if let Some(offered) = offered {
        // The model chooses whether to read with them (`auto`, every provider's default).
        body["tools"] = offered;
    }
    if settings.model.trim().is_empty() {
        return Err(Error::Validation("Choose the model to ask".into()));
    }
    Ok(Call {
        url,
        headers,
        body: Some(body.to_string()),
    })
}

/// A model name in a path: letters, digits and `-._:`, anything else escaped.
fn encode(text: &str) -> String {
    text.bytes()
        .map(|byte| match byte {
            b'a'..=b'z' | b'A'..=b'Z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b':' => {
                (byte as char).to_string()
            }
            other => format!("%{other:02X}"),
        })
        .collect()
}

/// What a refused call means to the person, from its status and the provider's message.
pub fn failure(status: u16, body: &str, retry_after: Option<&str>) -> String {
    let said = match serde_json::from_str::<Value>(body) {
        Ok(value) => value["error"]["message"]
            .as_str()
            .or_else(|| value["error"].as_str())
            .or_else(|| value["message"].as_str())
            .unwrap_or_default()
            .chars()
            .take(300)
            .collect(),
        Err(_) => body.trim().chars().take(300).collect::<String>(),
    };
    let reason = match status {
        401 | 403 => "The provider refused the API key: check it in Settings".to_owned(),
        404 => "The provider does not know this model or address".to_owned(),
        429 => match retry_after {
            Some(seconds) => format!("Too many requests: try again in {seconds} s"),
            None => "Too many requests: try again in a moment".to_owned(),
        },
        529 => "The provider is overloaded: try again in a moment".to_owned(),
        500..=599 => "The provider failed: try again in a moment".to_owned(),
        _ => format!("The provider answered HTTP {status}"),
    };
    if said.is_empty() {
        reason
    } else {
        format!("{reason} ({said})")
    }
}

mod events;
mod models;
mod thinking;
pub mod tools;
mod turn;
pub use events::{Delta, deltas};
pub use models::{Model, model_page, models};
pub use tools::{Answer, Tool, ToolCall};
pub use turn::Turn;

#[cfg(test)]
mod tests;
