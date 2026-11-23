//! The tools Nexo offers a model, in each provider's words, and their answers on the way
//! back: Anthropic's `tool_use` and `tool_result` blocks, OpenAI's `tool_calls` and `tool`
//! messages (also llama.cpp and the servers compatible with it), and Gemini's
//! `functionCall` and `functionResponse` parts. The tools only read: what they are and what
//! they may touch is the application's to decide.
use nexo_domain::{Error, Result, ai::Provider};
use serde::Serialize;
use serde_json::{Value, json};

/// Tools offered to a model at most.
pub const MAX_TOOLS: usize = 32;
/// The prefix of the ids Nexo gives the calls of a provider that names none (Gemini).
pub const OWN_ID: &str = "nexo-call-";

/// A tool offered to the model.
#[derive(Debug, Clone, PartialEq)]
pub struct Tool {
    pub name: String,
    pub description: String,
    pub schema: Value,
}

/// A tool the model asked for, with what it passed.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ToolCall {
    pub id: String,
    pub name: String,
    pub input: Value,
}

/// What a tool gave back to the model.
#[derive(Debug, Clone, PartialEq)]
pub struct Answer {
    pub id: String,
    pub text: String,
    pub failed: bool,
}

fn valid_name(name: &str) -> bool {
    (1..=64).contains(&name.len())
        && name
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
}

/// The tools of a payload: `[{name, description, inputSchema}]`.
pub fn parse(value: &Value) -> Result<Vec<Tool>> {
    let Some(items) = value.as_array() else {
        return Ok(Vec::new());
    };
    if items.len() > MAX_TOOLS {
        return Err(Error::Validation(format!(
            "A model is offered at most {MAX_TOOLS} tools"
        )));
    }
    items
        .iter()
        .map(|item| {
            let name = item["name"].as_str().unwrap_or_default();
            if !valid_name(name) {
                return Err(Error::Validation(format!("{name} is not a name of a tool")));
            }
            Ok(Tool {
                name: name.into(),
                description: item["description"].as_str().unwrap_or_default().into(),
                schema: match &item["inputSchema"] {
                    Value::Object(_) => item["inputSchema"].clone(),
                    _ => json!({"type": "object", "properties": {}}),
                },
            })
        })
        .collect()
}

/// The `tools` of a request body, absent when none is offered.
pub fn definitions(provider: Provider, tools: &[Tool]) -> Option<Value> {
    if tools.is_empty() {
        return None;
    }
    Some(match provider {
        Provider::Anthropic => tools
            .iter()
            .map(|tool| {
                json!({"name": tool.name, "description": tool.description, "input_schema": tool.schema})
            })
            .collect(),
        Provider::Openai | Provider::Compatible | Provider::Local => tools
            .iter()
            .map(|tool| {
                json!({"type": "function", "function": {
                    "name": tool.name, "description": tool.description, "parameters": tool.schema}})
            })
            .collect(),
        Provider::Gemini => json!([{"functionDeclarations": tools
            .iter()
            .map(|tool| json!({"name": tool.name, "description": tool.description, "parameters": tool.schema}))
            .collect::<Vec<_>>()}]),
    })
}

/// The messages that give the model the answers of its `calls`, in their order. Every call
/// has its answer.
pub fn results(provider: Provider, calls: &[ToolCall], answers: &[Answer]) -> Result<Vec<Value>> {
    let answered = calls
        .iter()
        .map(|call| {
            answers
                .iter()
                .find(|answer| answer.id == call.id)
                .map(|answer| (call, answer))
                .ok_or_else(|| Error::Validation(format!("The tool {} has no answer", call.name)))
        })
        .collect::<Result<Vec<_>>>()?;
    Ok(match provider {
        Provider::Anthropic => vec![json!({"role": "user", "content": answered
            .iter()
            .map(|(call, answer)| json!({"type": "tool_result", "tool_use_id": call.id,
                "content": answer.text, "is_error": answer.failed}))
            .collect::<Vec<_>>()})],
        Provider::Openai | Provider::Compatible | Provider::Local => answered
            .iter()
            .map(|(call, answer)| json!({"role": "tool", "tool_call_id": call.id, "content": answer.text}))
            .collect(),
        Provider::Gemini => vec![json!({"role": "user", "parts": answered
            .iter()
            .map(|(call, answer)| {
                let key = if answer.failed { "error" } else { "result" };
                let mut response = json!({"name": call.name, "response": {}});
                response["response"][key] = json!(answer.text);
                if !call.id.starts_with(OWN_ID) {
                    response["id"] = json!(call.id);
                }
                json!({"functionResponse": response})
            })
            .collect::<Vec<_>>()})],
    })
}

#[cfg(test)]
mod tests;
