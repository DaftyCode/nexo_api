//! Masking what may be secret before a document is shared: credentials in authorizations,
//! credential headers and sensitive variables, as in a Git export.
use serde_json::{Value, json};

pub const MASKED: &str = "••••••";
pub const REDACTED: &str = "[REDACTED]";
/// Settings that belong to this computer: transport settings and routes (proxy passwords,
/// SSH profiles) never leave it with a shared document.
pub(crate) const LOCAL_SETTINGS: [&str; 2] = ["nexoTransport", "nexoRoute"];
/// Authorization types whose rows may hold credentials.
pub(super) const AUTH_TYPES: [&str; 13] = [
    "basic", "bearer", "apikey", "oauth2", "digest", "oauth1", "awsv4", "hawk", "ntlm", "jwt",
    "asap", "edgegrid", "wsse",
];
/// Rows of those types that are credentials.
pub(super) const SECRET_AUTH_KEYS: [&str; 17] = [
    "token",
    "password",
    "value",
    "accessToken",
    "clientSecret",
    "refreshToken",
    "code_verifier",
    "consumerSecret",
    "tokenSecret",
    "privateKey",
    "accessTokenSecret",
    "secretKey",
    "secretAccessKey",
    "sessionToken",
    "authKey",
    "secret",
    "idToken",
];
pub(super) const SENSITIVE_HEADERS: [&str; 9] = [
    "authorization",
    "proxy-authorization",
    "cookie",
    "set-cookie",
    "x-api-key",
    "api-key",
    "x-auth-token",
    "private-token",
    "x-access-token",
];

/// A value without its secret: empty values and `{{references}}` stay, they hold none.
pub(super) fn hide(value: &Value) -> Value {
    match value.as_str() {
        Some("") => value.clone(),
        Some(text) if is_reference(text) => value.clone(),
        _ if value.is_null() => Value::Null,
        _ => json!(MASKED),
    }
}
pub(crate) fn is_reference(text: &str) -> bool {
    let text = text.trim();
    text.starts_with("{{") && text.ends_with("}}") && !text[2..text.len() - 2].contains(['{', '}'])
}
/// Variable names that hold credentials, as the interface marks them.
pub(crate) fn sensitive_name(name: &str) -> bool {
    let name = name.to_ascii_lowercase();
    ["password", "secret", "token", "authorization", "credential"]
        .iter()
        .any(|word| name.contains(word))
        || [
            "apikey",
            "api_key",
            "api-key",
            "privatekey",
            "private_key",
            "private-key",
        ]
        .iter()
        .any(|word| name.contains(word))
}
pub(super) fn masked_rows(rows: &[Value], secret: impl Fn(&Value) -> bool) -> Value {
    Value::Array(
        rows.iter()
            .map(|row| match row {
                Value::Object(fields) if secret(row) && fields.contains_key("value") => {
                    let mut fields = fields.clone();
                    fields.insert("value".into(), hide(&row["value"]));
                    Value::Object(fields)
                }
                other => shareable(other),
            })
            .collect(),
    )
}

/// A document as it may be shared: masked credentials and no local transport settings.
pub fn shareable(value: &Value) -> Value {
    visit(value, "")
}
pub(super) fn visit(value: &Value, key: &str) -> Value {
    match value {
        Value::Array(rows) if AUTH_TYPES.contains(&key) => masked_rows(rows, |row| {
            let name = row["key"].as_str().unwrap_or("");
            SECRET_AUTH_KEYS.contains(&name) || (key == "hawk" && name == "key")
        }),
        Value::Array(rows) if key == "header" || key == "headers" => masked_rows(rows, |row| {
            SENSITIVE_HEADERS.contains(
                &row["key"]
                    .as_str()
                    .unwrap_or("")
                    .to_ascii_lowercase()
                    .as_str(),
            )
        }),
        Value::Array(rows) if key == "variable" || key == "values" => masked_rows(rows, |row| {
            row["type"] == "secret"
                || row["secret"] == true
                || sensitive_name(row["key"].as_str().unwrap_or(""))
        }),
        Value::Array(items) => Value::Array(items.iter().map(|item| visit(item, "")).collect()),
        Value::Object(fields) => Value::Object(
            fields
                .iter()
                .filter(|(name, _)| !LOCAL_SETTINGS.contains(&name.as_str()))
                .map(|(name, item)| (name.clone(), visit(item, name)))
                .collect(),
        ),
        other => other.clone(),
    }
}
