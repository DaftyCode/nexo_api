//! Atlassian ASAP (S2S auth), as Postman signs it (postman-runtime `asap.js`): a short-lived
//! JWT with `iss`, `sub`, `aud`, `jti`, `iat` and `exp`, and `kid` in its header, sent as
//! `Authorization: Bearer <jwt>`. Signed with the JWT Bearer signer (RSA or ECDSA; ASAP has no
//! HMAC). Insomnia names the keys `issuer`, `subject`, `audience`, `keyId` and
//! `additionalClaims`.
//!
//! As in Postman, the additional claims win over the fields, `sub` falls back to `iss`, `jti` is
//! a new UUID on every send, and the token is valid for `exp` seconds (an hour by default). The
//! private key may be PEM, with or without line breaks, or Atlassian's
//! `data:application/pkcs8;kid=…;base64,…` URI.
use std::time::{SystemTime, UNIX_EPOCH};

use base64::{Engine as _, engine::general_purpose::STANDARD};
use nexo_domain::{Error, Result};
use serde_json::{Map, Value, json};

use super::jwt::{self, SigningKey};
use super::{Outgoing, first};

const DEFAULT_EXPIRY: u64 = 3600;

fn invalid(message: impl Into<String>) -> Error {
    Error::Validation(message.into())
}

/// The additional claims: a JSON object, or text holding one; blank means none.
fn claims(value: Option<&Value>) -> Result<Map<String, Value>> {
    match value {
        None | Some(Value::Null) => Ok(Map::new()),
        Some(Value::Object(object)) => Ok(object.clone()),
        Some(Value::String(text)) if text.trim().is_empty() => Ok(Map::new()),
        Some(Value::String(text)) => match serde_json::from_str(text.trim()) {
            Ok(Value::Object(object)) => Ok(object),
            _ => Err(invalid("Failed to parse claims")),
        },
        Some(_) => Err(invalid("Failed to parse claims")),
    }
}

/// A claim given as text: the claims object wins over the field.
fn claim_text(claims: &Map<String, Value>, key: &str, field: &str) -> String {
    match claims.get(key) {
        Some(Value::String(value)) if !value.is_empty() => value.clone(),
        _ => field.to_string(),
    }
}

/// A number or a numeric text (JavaScript's `parseInt`), when positive.
fn seconds(value: Option<&Value>) -> Option<u64> {
    match value? {
        Value::Number(number) => number.as_u64(),
        Value::String(text) => {
            let digits: String = text
                .trim()
                .chars()
                .take_while(char::is_ascii_digit)
                .collect();
            digits.parse().ok()
        }
        _ => None,
    }
    .filter(|seconds| *seconds > 0)
}

fn pem(label: &str, base64: &str) -> String {
    let lines: Vec<String> = base64
        .as_bytes()
        .chunks(64)
        .map(|line| String::from_utf8_lossy(line).into_owned())
        .collect();
    format!(
        "-----BEGIN {label}-----\n{}\n-----END {label}-----\n",
        lines.join("\n")
    )
}

/// The private key as PEM: Postman removes line breaks and quotes, decodes the text as a URI
/// component and reads Atlassian's data URIs, whose key id must match `kid`.
fn private_key(kid: &str, stored: &str) -> Result<String> {
    let failed = || invalid("Failed to parse private key.");
    let joined: String = stored
        .chars()
        .filter(|c| *c != '\n' && *c != '\r')
        .collect();
    let unquoted = joined
        .strip_prefix('"')
        .and_then(|rest| rest.strip_suffix('"'))
        .unwrap_or(&joined);
    let decoded = if unquoted.contains('%') {
        url::form_urlencoded::parse(format!("k={}", unquoted.replace('+', "%2B")).as_bytes())
            .next()
            .map(|(_, value)| value.into_owned())
            .ok_or_else(failed)?
    } else {
        unquoted.to_string()
    };
    if let Some(uri) = decoded.strip_prefix("data:") {
        let (id, base64) = uri
            .strip_prefix("application/pkcs8;kid=")
            .and_then(|rest| rest.split_once(";base64,"))
            .ok_or_else(|| invalid("Malformed Data URI"))?;
        if id != kid {
            return Err(invalid(
                "Supplied key id does not match the one included in data uri.",
            ));
        }
        STANDARD.decode(base64).map_err(|_| failed())?;
        return Ok(pem("PRIVATE KEY", base64));
    }
    // PEM whose line breaks were removed: rebuild the lines between the markers.
    let begin = decoded.find("-----BEGIN ").ok_or_else(failed)?;
    let label_end = decoded[begin + 11..].find("-----").ok_or_else(failed)? + begin + 11;
    let label = &decoded[begin + 11..label_end];
    let end_marker = format!("-----END {label}-----");
    let end = decoded.find(&end_marker).ok_or_else(failed)?;
    let base64: String = decoded[label_end + 5..end]
        .chars()
        .filter(|c| !c.is_whitespace())
        .collect();
    Ok(pem(label, &base64))
}

pub fn sign(auth: &Map<String, Value>, request: &mut Outgoing) -> Result<()> {
    let mut payload = claims(auth.get("claims").or_else(|| auth.get("additionalClaims")))?;
    let issuer = claim_text(&payload, "iss", &first(auth, &["iss", "issuer"]));
    let subject = match claim_text(&payload, "sub", &first(auth, &["sub", "subject"])) {
        blank if blank.is_empty() => issuer.clone(),
        subject => subject,
    };
    let audience = match payload.get("aud") {
        Some(Value::String(value)) if !value.is_empty() => Value::String(value.clone()),
        Some(Value::Array(values)) if !values.is_empty() => Value::Array(values.clone()),
        _ => Value::String(first(auth, &["aud", "audience"])),
    };
    let kid = claim_text(&payload, "kid", &first(auth, &["kid", "keyId"]));
    let stored_key = first(auth, &["privateKey"]);
    let jti = claim_text(&payload, "jti", &uuid::Uuid::new_v4().to_string());
    if kid.is_empty() || issuer.is_empty() || audience == json!("") || stored_key.is_empty() {
        return Err(invalid("One or more of required claims missing"));
    }
    let algorithm = match first(auth, &["alg", "algorithm"]) {
        blank if blank.is_empty() => "RS256".to_string(),
        algorithm => algorithm,
    };
    if algorithm.starts_with("HS") || !jwt::ALGORITHMS.contains(&algorithm.as_str()) {
        return Err(invalid("invalid algorithm"));
    }
    let key = private_key(&kid, &stored_key)?;

    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_secs())
        .unwrap_or_default();
    let issued_at = payload
        .get("iat")
        .filter(|value| !matches!(value, Value::Null | Value::Bool(false)))
        .cloned()
        .unwrap_or_else(|| json!(now));
    let lifetime = seconds(auth.get("exp")).unwrap_or(DEFAULT_EXPIRY);
    let expires = seconds(payload.get("exp")).unwrap_or(now + lifetime);
    // In jose's order: the claims, then iat, iss, sub, jti, aud and exp.
    payload.insert("iat".into(), issued_at);
    payload.insert("iss".into(), Value::String(issuer));
    payload.insert("sub".into(), Value::String(subject));
    payload.insert("jti".into(), Value::String(jti));
    payload.insert("aud".into(), audience);
    payload.insert("exp".into(), json!(expires));

    let mut header = Map::new();
    header.insert("alg".into(), Value::String(algorithm.clone()));
    header.insert("kid".into(), Value::String(kid));
    let token = jwt::token(&algorithm, header, &payload, SigningKey::PrivateKey(&key))?;
    request
        .headers
        .set("Authorization", &format!("Bearer {token}"));
    request.credential_headers.push("Authorization".into());
    Ok(())
}

#[cfg(test)]
mod tests;
