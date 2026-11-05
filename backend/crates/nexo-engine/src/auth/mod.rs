//! Request authorization, applied to a request once it is fully built.
//!
//! The stored format is Postman's (`{type, <type>: [{key, value}]}`), and each type follows
//! the matching Postman authorizer (postman-runtime, `lib/authorizer/<type>.js`), with the
//! options Insomnia and Bruno add, so exported collections behave the same. Each type has its
//! own file; [`sign`] adds credentials before sending and [`answer_challenge`] lets a type
//! answer a `401`/`403` challenge once (Digest).
use nexo_domain::{Error, Result};
use serde_json::{Map, Value};
use url::Url;

use crate::transport::HeaderList;

mod apikey;
mod asap;
mod awsv4;
mod basic;
mod bearer;
pub mod digest;
mod edgegrid;
mod hawk;
pub mod jwt;
mod ntlm;
mod oauth1;
mod oauth2;

/// The values of a stored authorization, flattened into one map with its `type`.
pub fn values(auth: &Value) -> Map<String, Value> {
    let mut values = auth.as_object().cloned().unwrap_or_default();
    let kind = auth["type"].as_str().unwrap_or("");
    match &auth[kind] {
        Value::Array(rows) => {
            for row in rows {
                if let Some(key) = row["key"].as_str() {
                    values.insert(key.to_string(), row["value"].clone());
                }
            }
        }
        Value::Object(object) => values.extend(object.clone()),
        _ => {}
    }
    values
}

pub(crate) fn text(value: Option<&Value>) -> String {
    match value {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Null) | None => String::new(),
        Some(other) => other.to_string(),
    }
}

/// The first non-blank value among a key and its names in other tools.
pub(crate) fn first(auth: &Map<String, Value>, keys: &[&str]) -> String {
    keys.iter()
        .map(|key| text(auth.get(*key)))
        .find(|value| !value.trim().is_empty())
        .unwrap_or_default()
}

/// RFC 3986 percent-encoding: everything but `A-Z a-z 0-9 - . _ ~`.
pub fn percent_encode(value: &str) -> String {
    let mut encoded = String::with_capacity(value.len());
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric() || b"-._~".contains(&byte) {
            encoded.push(byte as char);
        } else {
            encoded.push_str(&format!("%{byte:02X}"));
        }
    }
    encoded
}

/// Whether a stored flag is on (`true` or `"true"`).
pub(crate) fn flag(auth: &Map<String, Value>, key: &str) -> bool {
    matches!(auth.get(key), Some(Value::Bool(true))) || text(auth.get(key)) == "true"
}

/// The request as it will be sent, which the signing helpers read and change.
pub struct Outgoing<'a> {
    pub method: &'a str,
    pub url: &'a mut Url,
    pub headers: &'a mut HeaderList,
    /// OAuth 1.0 adds its parameters to `x-www-form-urlencoded` bodies.
    pub body: &'a mut Vec<u8>,
    /// Header names that carry credentials: they are dropped on a cross-origin redirect.
    pub credential_headers: &'a mut Vec<String>,
}

fn kind(auth: &Map<String, Value>) -> &str {
    auth.get("type").and_then(Value::as_str).unwrap_or("")
}

/// Adds the credentials of `auth` to a request before it is sent.
pub fn sign(auth: &Map<String, Value>, request: &mut Outgoing) -> Result<()> {
    match kind(auth) {
        "basic" => basic::sign(auth, request),
        "bearer" => bearer::sign(auth, request),
        "oauth2" => oauth2::sign(auth, request),
        "apikey" => apikey::sign(auth, request),
        "digest" => digest::sign(auth, request),
        "oauth1" => oauth1::sign(auth, request),
        "awsv4" => awsv4::sign(auth, request),
        "hawk" => hawk::sign(auth, request),
        "ntlm" => ntlm::sign(auth, request),
        "jwt" => jwt::sign(auth, request),
        "asap" => asap::sign(auth, request),
        "edgegrid" => edgegrid::sign(auth, request),
        "" | "noauth" | "inherit" => Ok(()),
        other => Err(Error::Validation(format!(
            "Unsupported authentication helper: {other}"
        ))),
    }
}

/// After a `401`/`403`, whether the type answered the server's challenge in `request`'s
/// headers and the request should be sent once more. `round` counts the answers already sent:
/// Digest answers once, NTLM twice (negotiate, then authenticate).
pub fn answer_challenge(
    auth: &mut Map<String, Value>,
    round: usize,
    status: u16,
    challenges: &[String],
    request: &mut Outgoing,
) -> Result<bool> {
    match kind(auth) {
        "digest" if round == 0 => digest::answer(auth, status, challenges, request),
        "ntlm" => ntlm::answer(auth, round, status, challenges, request),
        _ => Ok(false),
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use serde_json::json;

    /// Signs `auth` on a GET of `url` that already has an `Authorization: Basic old` header.
    pub fn signed(auth: Value, url: &str) -> (Url, HeaderList) {
        let mut url = Url::parse(url).unwrap();
        let mut headers = HeaderList::default();
        headers.set("Authorization", "Basic old");
        let mut credentials = Vec::new();
        sign(
            &values(&auth),
            &mut Outgoing {
                method: "GET",
                url: &mut url,
                headers: &mut headers,
                body: &mut Vec::new(),
                credential_headers: &mut credentials,
            },
        )
        .unwrap();
        (url, headers)
    }

    #[test]
    fn unknown_types_are_reported() {
        let mut url = Url::parse("https://x").unwrap();
        let error = sign(
            &values(&json!({"type": "made-up"})),
            &mut Outgoing {
                method: "GET",
                url: &mut url,
                headers: &mut HeaderList::default(),
                body: &mut Vec::new(),
                credential_headers: &mut Vec::new(),
            },
        )
        .unwrap_err();
        assert!(
            error
                .to_string()
                .contains("Unsupported authentication helper: made-up")
        );
    }
}
