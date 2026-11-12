//! Authorization of Insomnia and Bruno requests in Nexo's (Postman's) stored format,
//! `{type, <type>: [{key, value, type}]}`, for importing their collections (B-07).
//!
//! Each type is renamed to Postman's and its keys to Postman's names, so the editor shows them
//! and exports read like Postman's. `None` means the request inherits its authorization.
//! Mappings checked against Insomnia's `models/request.ts` and Bruno's `bruno-schema` on
//! 2026-11-05.

mod bruno;
mod insomnia;

pub use bruno::from_bruno;
pub use insomnia::from_insomnia;
use serde_json::{Map, Value, json};

/// Postman rows from `(key, value)` pairs, leaving out values that are absent.
fn stored(kind: &str, pairs: Vec<(&str, Value)>) -> Value {
    let rows: Vec<Value> = pairs
        .into_iter()
        .filter(|(_, value)| !value.is_null())
        .map(|(key, value)| {
            let row_type = match &value {
                Value::Bool(_) => "boolean",
                Value::Number(_) => "number",
                Value::Array(_) => "any",
                _ => "string",
            };
            json!({"key": key, "value": value, "type": row_type})
        })
        .collect();
    json!({"type": kind, kind: rows})
}

/// Copies `from` keys of `source` under their Postman names.
fn renamed(source: &Value, keys: &[(&str, &str)]) -> Vec<(String, Value)> {
    keys.iter()
        .map(|(from, to)| (to.to_string(), source[*from].clone()))
        .collect()
}

fn owned(kind: &str, pairs: Vec<(String, Value)>) -> Value {
    stored(
        kind,
        pairs
            .iter()
            .map(|(key, value)| (key.as_str(), value.clone()))
            .collect(),
    )
}

/// Keeps a type Nexo does not know as it was, so that it is neither lost nor misread.
fn unknown(kind: &str, source: &Value) -> Value {
    let values: Map<String, Value> = source.as_object().cloned().unwrap_or_default();
    owned(
        kind,
        values
            .into_iter()
            .filter(|(key, _)| key != "type" && key != "mode")
            .collect(),
    )
}

#[cfg(test)]
mod tests;
