//! `{{vault:name}}` references: finding them, replacing them with their values and keeping
//! those values out of errors.
use nexo_domain::Error;
use serde_json::Value;

/// Fields that contain script source. Vault references there are never resolved, so an
/// imported collection cannot make secrets available to its scripts.
const SCRIPT_FIELDS: [&str; 5] = ["event", "prerequest", "tests", "script", "exec"];

/// Vault entries of OAuth 2.0 tokens that requests reference: their access and ID tokens.
pub(crate) fn is_oauth2_token(name: &str) -> bool {
    name.starts_with("nexo-oauth2:") || name.starts_with("nexo-oauth2-id:")
}

/// Replaces `{{vault:name}}` references in `text` with their values. In a URI the values are
/// percent-encoded, so a user name such as `ana@corp` cannot change where it connects.
pub(crate) fn replace_vault(text: &str, values: &[(String, String)], in_uri: bool) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(start) = rest.find("{{") {
        out.push_str(&rest[..start]);
        let after = &rest[start + 2..];
        let Some(end) = after.find("}}") else {
            rest = &rest[start..];
            break;
        };
        let inner = after[..end].trim();
        let value = inner
            .strip_prefix("vault:")
            .map(str::trim)
            .and_then(|name| values.iter().find(|(n, _)| n == name));
        match value {
            Some((_, value)) if in_uri => out.push_str(&uri_encode(value)),
            Some((_, value)) => out.push_str(value),
            None => out.push_str(&rest[start..start + 2 + end + 2]),
        }
        rest = &after[end + 2..];
    }
    out.push_str(rest);
    out
}

/// Percent-encodes what would change the meaning of a connection URI.
pub(crate) fn uri_encode(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric() || b"-._~!$&'()*+;=".contains(&byte) {
            out.push(byte as char);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

/// Removes secret values (also percent-encoded) from an error before it leaves.
pub(crate) fn redact_error(error: Error, values: &[(String, String)]) -> Error {
    let redact = |mut message: String| {
        for (_, value) in values {
            // Very short values would turn ordinary words into noise.
            if value.chars().count() >= 3 {
                message = message
                    .replace(value.as_str(), "[redacted]")
                    .replace(&uri_encode(value), "[redacted]");
            }
        }
        message
    };
    match error {
        Error::Validation(message) => Error::Validation(redact(message)),
        Error::Unavailable(message) => Error::Unavailable(redact(message)),
        Error::Infrastructure(message) => Error::Infrastructure(redact(message)),
        other => other,
    }
}

/// Collects `{{vault:name}}` references outside script fields.
pub fn vault_references(value: &Value) -> Vec<String> {
    fn visit(value: &Value, names: &mut Vec<String>) {
        match value {
            Value::String(text) => {
                // Same syntax as the runtime: `{{ vault:name }}`, surrounding spaces allowed.
                let mut rest = text.as_str();
                while let Some(index) = rest.find("{{") {
                    rest = &rest[index + 2..];
                    let Some(end) = rest.find("}}") else { break };
                    let inner = rest[..end].trim();
                    if let Some(name) = inner.strip_prefix("vault:").map(str::trim)
                        && !name.is_empty()
                        && name.len() <= 200
                        && !name.contains(['{', '}'])
                        && !names.iter().any(|n| n == name)
                    {
                        names.push(name.to_string());
                    }
                    rest = &rest[end + 2..];
                }
            }
            Value::Array(items) => items.iter().for_each(|item| visit(item, names)),
            Value::Object(map) => map
                .iter()
                .filter(|(key, _)| !SCRIPT_FIELDS.contains(&key.as_str()))
                .for_each(|(_, item)| visit(item, names)),
            _ => {}
        }
    }
    let mut names = Vec::new();
    visit(value, &mut names);
    names
}
