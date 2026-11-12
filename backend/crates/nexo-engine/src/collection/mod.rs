//! Portable collection format (Postman Collection v2.1 compatible) handled by the engine.

mod item;
mod url;

pub use item::request_item;
use nexo_domain::{Error, Result};
use serde_json::{Map, Value, json};
pub use url::{encode_component, encode_query_part, fill_path_variables, request_url};

pub const SCHEMA: &str = "urn:nexo:collection:1";

/// HTTP method token (RFC 9110); rejects values that could alter generated code.
pub fn http_method(value: &str) -> Result<String> {
    let method = value.trim().to_uppercase();
    let method = if method.is_empty() {
        "GET".to_string()
    } else {
        method
    };
    let valid = method.len() <= 32
        && method
            .chars()
            .next()
            .is_some_and(|c| c.is_ascii_uppercase())
        && method
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "!#$%&'*+.^_`|~-".contains(c));
    if valid {
        Ok(method)
    } else {
        Err(Error::Validation(format!("Invalid HTTP method: {value}")))
    }
}

fn rows(value: &Value, enabled_key: bool) -> Vec<&Map<String, Value>> {
    value
        .as_array()
        .map(|rows| {
            rows.iter()
                .filter_map(Value::as_object)
                .filter(|row| {
                    row.get("key")
                        .and_then(Value::as_str)
                        .is_some_and(|k| !k.is_empty())
                        && if enabled_key {
                            row.get("enabled") != Some(&Value::Bool(false))
                        } else {
                            true
                        }
                })
                .collect()
        })
        .unwrap_or_default()
}
fn text(value: Option<&Value>) -> String {
    match value {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Null) | None => String::new(),
        Some(other) => other.to_string(),
    }
}

fn inheritable(ancestor: &Value) -> Map<String, Value> {
    let mut output = Map::new();
    for key in ["variable", "event"] {
        if let Some(value) = ancestor.get(key).filter(|v| v.is_array()) {
            output.insert(key.into(), value.clone());
        }
    }
    if let Some(auth) = ancestor.get("auth").filter(|v| v.is_object()) {
        output.insert("auth".into(), auth.clone());
    }
    output
}

/// The collection to execute. A single request keeps what it inherits from the collection
/// and folders above it (`context.ancestors`, root first).
pub fn as_collection(payload: &Value) -> Result<Value> {
    if payload["collection"]["item"].is_array() {
        return Ok(payload["collection"].clone());
    }
    let item = match payload.get("item").filter(|item| item.is_object()) {
        Some(item) => item.clone(),
        None => request_item(payload.get("request").unwrap_or(&Value::Null))?,
    };
    let ancestors: Vec<Value> = payload["context"]["ancestors"]
        .as_array()
        .map(|list| list.iter().take(32).cloned().collect())
        .unwrap_or_default();
    let mut nested = item;
    for folder in ancestors.iter().skip(1).rev() {
        let mut group = inheritable(folder);
        group.insert(
            "name".into(),
            json!(folder["name"].as_str().unwrap_or("Folder")),
        );
        group.insert("item".into(), json!([nested]));
        nested = Value::Object(group);
    }
    let mut root = ancestors.first().map(inheritable).unwrap_or_default();
    let name = payload["request"]["name"]
        .as_str()
        .or_else(|| payload["item"]["name"].as_str())
        .unwrap_or("Request");
    root.insert("info".into(), json!({"name": name, "schema": SCHEMA}));
    root.insert("item".into(), json!([nested]));
    Ok(Value::Object(root))
}

#[cfg(test)]
mod tests;
