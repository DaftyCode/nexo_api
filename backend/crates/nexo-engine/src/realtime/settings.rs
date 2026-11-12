//! What a connection payload asks for besides its URL: headers and credentials.
use super::*;

/// Replaces vault references in `username` and `password` with the secrets the application
/// resolved, and fails when one may not go to the connection's host.
pub(super) fn with_credentials(payload: &Value) -> Result<Value> {
    let referenced =
        nexo_application::vault_references(&json!([payload["username"], payload["password"]]));
    if referenced.is_empty() {
        return Ok(payload.clone());
    }
    let host = Url::parse(payload["url"].as_str().unwrap_or_default())
        .ok()
        .and_then(|url| url.host_str().map(String::from))
        .unwrap_or_default();
    for secret in crate::secret_hosts::restricted(payload) {
        if referenced.contains(&secret.name) && !secret.hosts.allows(&host) {
            return Err(crate::secret_hosts::denied(&secret.name, &host));
        }
    }
    let secrets: serde_json::Map<String, Value> = payload["resolvedSecrets"]
        .as_object()
        .into_iter()
        .flatten()
        .map(|(name, value)| (format!("vault:{name}"), value.clone()))
        .collect();
    let mut filled = payload.clone();
    for field in ["username", "password"] {
        if let Some(text) = payload[field].as_str() {
            filled[field] = json!(crate::scripts::fill(text, &secrets));
        }
    }
    Ok(filled)
}

pub(super) fn header_rows(value: &Value) -> Vec<(String, String)> {
    let text = |value: &Value| match value {
        Value::String(text) => text.clone(),
        Value::Null => String::new(),
        other => other.to_string(),
    };
    match value {
        Value::Array(rows) => rows
            .iter()
            .filter(|row| row["enabled"] != false)
            .filter_map(|row| {
                row["key"]
                    .as_str()
                    .filter(|k| !k.is_empty())
                    .map(|k| (k.to_string(), text(&row["value"])))
            })
            .collect(),
        Value::Object(map) => map.iter().map(|(k, v)| (k.clone(), text(v))).collect(),
        _ => Vec::new(),
    }
}
