//! Token responses and tokens pasted by the person: their fields and when they expire.
use super::*;

/// Reads a token endpoint answer: JSON or `application/x-www-form-urlencoded`.
pub fn token_response(status: u16, body: &str, now_ms: u64) -> Result<Value> {
    let fields: Map<String, Value> = match serde_json::from_str::<Value>(body) {
        Ok(Value::Object(map)) => map,
        _ => url::form_urlencoded::parse(body.as_bytes())
            .map(|(k, v)| (k.into_owned(), Value::String(v.into_owned())))
            .collect(),
    };
    token_fields(status, &fields, now_ms)
}

/// The expiry of a JWT (its `exp`, in milliseconds), read without checking the signature:
/// only to know when to renew a token the person pasted.
pub fn jwt_expiry(token: &str) -> Option<u64> {
    let payload = token.split('.').nth(1)?;
    let claims: Value =
        serde_json::from_slice(&URL_SAFE_NO_PAD.decode(payload.trim_end_matches('=')).ok()?)
            .ok()?;
    claims["exp"].as_u64().map(|seconds| seconds * 1000)
}

/// A token the person pasted, when the sign-in cannot take one by itself (a Callback URL that
/// another application consumes, in the web version). Kept like an obtained token, so it can
/// be selected and, with its refresh token, renewed. A JWT gives its expiry.
pub fn pasted_token(fields: &Map<String, Value>, now_ms: u64) -> Result<Value> {
    let value = |key: &str| {
        let text = text(fields.get(key));
        let text = text.trim();
        let text = text
            .strip_prefix("Bearer ")
            .or_else(|| text.strip_prefix("bearer "))
            .unwrap_or(text)
            .trim();
        (!text.is_empty()).then(|| Value::String(text.to_string()))
    };
    let mut answer = Map::new();
    for (from, to) in [
        ("accessToken", "access_token"),
        ("idToken", "id_token"),
        ("refreshToken", "refresh_token"),
    ] {
        if let Some(value) = value(from) {
            answer.insert(to.into(), value);
        }
    }
    if !answer.contains_key("access_token") && !answer.contains_key("id_token") {
        return Err(invalid("Paste the access token"));
    }
    if let Some(seconds) = fields.get("expiresIn").and_then(Value::as_u64) {
        answer.insert("expires_in".into(), json!(seconds));
    }
    let mut token = token_fields(200, &answer, now_ms)?;
    if token["expiresAt"].is_null() {
        let jwt = token["accessToken"].as_str().or(token["idToken"].as_str());
        if let Some(expires) = jwt.and_then(jwt_expiry) {
            token["expiresAt"] = json!(expires);
        }
    }
    Ok(token)
}

/// The token in the fields of a token answer, or of an implicit grant's redirect.
pub(super) fn token_fields(status: u16, fields: &Map<String, Value>, now_ms: u64) -> Result<Value> {
    let get = |key: &str| {
        fields
            .get(key)
            .map(|v| text(Some(v)))
            .filter(|v| !v.is_empty())
    };
    if let Some(error) = get("error") {
        let description = get("error_description")
            .map(|d| format!(": {d}"))
            .unwrap_or_default();
        return Err(invalid(format!(
            "The token endpoint refused the request ({error}){description}"
        )));
    }
    if !(200..300).contains(&status) {
        return Err(invalid(format!(
            "The token endpoint answered with status {status}"
        )));
    }
    let access = get("access_token");
    let identity = get("id_token");
    if access.is_none() && identity.is_none() {
        return Err(invalid(
            "The token endpoint answered without an access_token or id_token",
        ));
    }
    let expires_in = fields
        .get("expires_in")
        .and_then(|v| v.as_u64().or_else(|| text(Some(v)).parse().ok()));
    Ok(json!({
        "accessToken": access,
        "idToken": identity,
        "refreshToken": get("refresh_token"),
        "tokenType": get("token_type"),
        "scope": get("scope"),
        "expiresIn": expires_in,
        "expiresAt": expires_in.map(|seconds| now_ms + seconds * 1000),
        "obtainedAt": now_ms,
    }))
}
