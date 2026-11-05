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
mod tests {
    use super::*;
    use crate::transport::HeaderList;
    use aws_lc_rs::{rand::SystemRandom, signature, signature::KeyPair};
    use base64::engine::general_purpose::URL_SAFE_NO_PAD;

    fn ec_key() -> (Vec<u8>, Vec<u8>) {
        let pkcs8 = signature::EcdsaKeyPair::generate_pkcs8(
            &signature::ECDSA_P256_SHA256_FIXED_SIGNING,
            &SystemRandom::new(),
        )
        .unwrap();
        let pair = signature::EcdsaKeyPair::from_pkcs8(
            &signature::ECDSA_P256_SHA256_FIXED_SIGNING,
            pkcs8.as_ref(),
        )
        .unwrap();
        (pkcs8.as_ref().to_vec(), pair.public_key().as_ref().to_vec())
    }

    fn send(rows: Value) -> Result<String> {
        let mut url = url::Url::parse("https://x").unwrap();
        let mut headers = HeaderList::default();
        sign(
            &crate::auth::values(&json!({"type": "asap", "asap": rows})),
            &mut Outgoing {
                method: "GET",
                url: &mut url,
                headers: &mut headers,
                body: &mut Vec::new(),
                credential_headers: &mut Vec::new(),
            },
        )?;
        Ok(headers.get("authorization")[0].to_string())
    }

    fn parts(authorization: &str) -> (Value, Value, String) {
        let token = authorization.strip_prefix("Bearer ").unwrap();
        let segments: Vec<&str> = token.split('.').collect();
        let read = |segment: &str| -> Value {
            serde_json::from_slice(&URL_SAFE_NO_PAD.decode(segment).unwrap()).unwrap()
        };
        (read(segments[0]), read(segments[1]), token.to_string())
    }

    #[test]
    fn signs_a_short_lived_token_like_postman() {
        let (pkcs8, public_key) = ec_key();
        // A PEM pasted without line breaks, as Postman's text field keeps it.
        let flat = pem("PRIVATE KEY", &STANDARD.encode(&pkcs8)).replace('\n', "");
        let rows = json!([
            {"key": "alg", "value": "ES256"},
            {"key": "kid", "value": "nexo/key-1"},
            {"key": "iss", "value": "nexo"},
            {"key": "aud", "value": "jira"},
            {"key": "privateKey", "value": flat},
            {"key": "claims", "value": "{\"scope\":\"read\"}"},
        ]);
        let first = send(rows.clone()).unwrap();
        let (header, payload, token) = parts(&first);
        assert_eq!(header, json!({"alg": "ES256", "kid": "nexo/key-1"}));
        let keys: Vec<&str> = payload
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        assert_eq!(keys, ["scope", "iat", "iss", "sub", "jti", "aud", "exp"]);
        assert_eq!(payload["sub"], "nexo");
        assert_eq!(payload["aud"], "jira");
        assert_eq!(
            payload["exp"].as_u64().unwrap() - payload["iat"].as_u64().unwrap(),
            3600
        );
        let (input, sig) = token.rsplit_once('.').unwrap();
        signature::UnparsedPublicKey::new(&signature::ECDSA_P256_SHA256_FIXED, public_key)
            .verify(input.as_bytes(), &URL_SAFE_NO_PAD.decode(sig).unwrap())
            .unwrap();
        // Every send has its own token id.
        let (_, again, _) = parts(&send(rows).unwrap());
        assert_ne!(again["jti"], payload["jti"]);
    }

    #[test]
    fn claims_win_and_insomnia_keys_and_data_uris_are_read() {
        let (pkcs8, _) = ec_key();
        let uri = format!(
            "data:application/pkcs8;kid=team%2Fkey;base64,{}",
            STANDARD.encode(&pkcs8)
        );
        let (_, payload, _) = parts(
            &send(json!([
                {"key": "algorithm", "value": "ES256"},
                {"key": "keyId", "value": "team/key"},
                {"key": "issuer", "value": "field-issuer"},
                {"key": "subject", "value": "field-subject"},
                {"key": "audience", "value": "field-audience"},
                {"key": "exp", "value": "60"},
                {"key": "privateKey", "value": uri},
                {"key": "additionalClaims", "value": "{\"iss\":\"claim-issuer\",\"aud\":[\"a\",\"b\"],\"jti\":\"fixed\"}"},
            ]))
            .unwrap(),
        );
        assert_eq!(payload["iss"], "claim-issuer");
        assert_eq!(payload["sub"], "field-subject");
        assert_eq!(payload["aud"], json!(["a", "b"]));
        assert_eq!(payload["jti"], "fixed");
        assert_eq!(
            payload["exp"].as_u64().unwrap() - payload["iat"].as_u64().unwrap(),
            60
        );
    }

    #[test]
    fn reports_missing_claims_bad_keys_and_algorithms() {
        let (pkcs8, _) = ec_key();
        let key = pem("PRIVATE KEY", &STANDARD.encode(&pkcs8));
        let base = |extra: Value| {
            let mut rows = vec![
                json!({"key": "kid", "value": "k"}),
                json!({"key": "iss", "value": "i"}),
                json!({"key": "aud", "value": "a"}),
                json!({"key": "privateKey", "value": key}),
                json!({"key": "alg", "value": "ES256"}),
            ];
            rows.extend(extra.as_array().unwrap().iter().cloned());
            send(Value::Array(rows)).unwrap_err().to_string()
        };
        assert!(base(json!([{"key": "kid", "value": ""}])).contains("required claims missing"));
        assert!(base(json!([{"key": "alg", "value": "HS256"}])).contains("invalid algorithm"));
        assert!(
            base(json!([{"key": "claims", "value": "{oops"}])).contains("Failed to parse claims")
        );
        assert!(
            base(json!([{"key": "privateKey", "value": "data:application/pkcs8;kid=other;base64,AAAA"}]))
                .contains("does not match")
        );
        assert!(base(json!([{"key": "privateKey", "value": "not a key"}])).contains("private key"));
    }
}
