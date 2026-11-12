//! OAuth 2.0 tokens a request or run needs before it is sent: refreshed when they are about
//! to expire and fetched when missing ("Auto-fetch token").
use super::*;

/// JSON pointers to every OAuth 2.0 authorization in a request or run payload.
pub(super) fn oauth2_pointers(value: &Value, pointer: &str, found: &mut Vec<String>) {
    match value {
        Value::Object(map) => {
            if map.get("type").and_then(Value::as_str) == Some("oauth2")
                && map.contains_key("oauth2")
            {
                found.push(pointer.to_string());
            }
            for (key, item) in map {
                let key = key.replace('~', "~0").replace('/', "~1");
                oauth2_pointers(item, &format!("{pointer}/{key}"), found);
            }
        }
        Value::Array(items) => {
            for (index, item) in items.iter().enumerate() {
                oauth2_pointers(item, &format!("{pointer}/{index}"), found);
            }
        }
        _ => {}
    }
}
/// Sets a value of a stored authorization, in Postman's rows or in an object.
pub(super) fn set_auth_value(auth: &mut Value, key: &str, value: Value) {
    let kind = auth["type"].as_str().unwrap_or("oauth2").to_string();
    match &mut auth[&kind] {
        Value::Array(rows) => match rows.iter_mut().find(|row| row["key"] == key) {
            Some(row) => row["value"] = value,
            None => rows.push(json!({"key": key, "value": value, "type": "string"})),
        },
        Value::Object(map) => {
            map.insert(key.into(), value);
        }
        other => *other = json!([{"key": key, "value": value, "type": "string"}]),
    }
}
/// Every OAuth 2.0 authorization in a request or run payload.
pub(super) fn oauth2_auths(value: &Value, found: &mut Vec<Value>) {
    match value {
        Value::Object(map) => {
            if map.get("type").and_then(Value::as_str) == Some("oauth2")
                && map.contains_key("oauth2")
            {
                found.push(value.clone());
            }
            map.values().for_each(|item| oauth2_auths(item, found));
        }
        Value::Array(items) => items.iter().for_each(|item| oauth2_auths(item, found)),
        _ => {}
    }
}
/// The settings of a stored OAuth 2.0 authorization, resolved with the variables of the
/// request or run it belongs to.
pub(super) fn oauth2_settings(payload: &Value, stored: &Value) -> Option<Map<String, Value>> {
    let context = if payload["collection"].is_object() {
        json!({"ancestors": [{"variable": payload["collection"]["variable"]}]})
    } else {
        payload["context"].clone()
    };
    let probe = json!({
        "request": {"name": "OAuth 2.0", "request": {"method": "GET", "url": "https://oauth2.invalid/", "auth": stored}},
        "variables": payload["variables"],
        "globals": payload["globals"],
        "context": context,
        "resolvedSecrets": payload["resolvedSecrets"],
    });
    runner::resolved_auth(&probe).ok()
}

impl Engine {
    /// Before a request or a run: renews the OAuth 2.0 tokens it uses that expire within a
    /// minute (Postman's "Auto-refresh Token", on unless turned off; failures keep the old
    /// token, as in Postman) and provides `{{$oauth2.<name>.access_token}}` (Bruno).
    pub(super) async fn prepare_oauth2(&self, mut payload: Value) -> Value {
        let text = payload.to_string();
        if text.contains("\"oauth2TokenId\"") {
            let mut auths = Vec::new();
            oauth2_auths(&payload, &mut auths);
            for auth in auths {
                self.refresh_expiring(&mut payload, auth).await;
            }
        }
        if text.contains("\"autoFetchToken\"") {
            let mut pointers = Vec::new();
            oauth2_pointers(&payload, "", &mut pointers);
            for pointer in pointers {
                self.fetch_missing(&mut payload, &pointer).await;
            }
        }
        if text.contains("$oauth2.")
            && let Ok(variables) = oauth2_tokens::variables(&self.vault).await
        {
            payload["resolvedOAuth2"] = Value::Object(variables);
        }
        payload
    }
    pub(super) async fn refresh_expiring(&self, payload: &mut Value, stored: Value) {
        let values = auth::values(&stored);
        let id = auth::text(values.get("oauth2TokenId"));
        let disabled = matches!(values.get("autoRefreshToken"), Some(Value::Bool(false)))
            || auth::text(values.get("autoRefreshToken")) == "false";
        if id.is_empty() || disabled {
            return;
        }
        let Ok(details) = oauth2_tokens::details(&self.vault, &id).await else {
            return;
        };
        let expiring = details["expiresAt"]
            .as_u64()
            .is_some_and(|at| at <= now_ms() + 60_000);
        let Some(refresh) = details["refreshToken"].as_str().filter(|t| !t.is_empty()) else {
            return;
        };
        if !expiring {
            return;
        }
        let Some(settings) = oauth2_settings(payload, &stored) else {
            return;
        };
        let Ok(request) = oauth2::token_request(&settings, oauth2::Exchange::Refresh(refresh))
        else {
            return;
        };
        let restricted = secret_hosts::referenced_by(&secret_hosts::restricted(payload), &stored);
        let Ok(token) = self.post_token(request, &restricted).await else {
            return;
        };
        if oauth2_tokens::replace(&self.vault, &id, &token)
            .await
            .is_err()
        {
            return;
        }
        // The vault references were resolved before the refresh: use the new values.
        if let Some(secrets) = payload["resolvedSecrets"].as_object_mut() {
            let access = token["accessToken"].as_str().or(token["idToken"].as_str());
            for (key, value) in [
                (format!("nexo-oauth2:{id}"), access),
                (format!("nexo-oauth2-id:{id}"), token["idToken"].as_str()),
            ] {
                if let Some(value) = value.filter(|_| secrets.contains_key(&key)) {
                    secrets.insert(key, json!(value));
                }
            }
        }
    }
    /// Bruno's "Auto-fetch Token": when an authorization asks for it and has no usable token,
    /// the newest valid token with its name is used, or, for grants without a browser, a new
    /// one is obtained and stored. Browser grants are signed in by the interface before
    /// sending; runs without one send the request as it is, as Bruno's CLI does.
    pub(super) async fn fetch_missing(&self, payload: &mut Value, pointer: &str) {
        let Some(stored) = payload.pointer(pointer).cloned() else {
            return;
        };
        let values = auth::values(&stored);
        if !auth::flag(&values, "autoFetchToken") {
            return;
        }
        let selected = auth::text(values.get("oauth2TokenId"));
        // A token typed in ("Custom token") is the user's choice.
        if selected.is_empty() && !auth::text(values.get("accessToken")).is_empty() {
            return;
        }
        let now = now_ms();
        if !selected.is_empty()
            && let Ok(details) = oauth2_tokens::details(&self.vault, &selected).await
            && oauth2_tokens::usable(&details, now)
        {
            return;
        }
        let Some(settings) = oauth2_settings(payload, &stored) else {
            return;
        };
        let name = match auth::text(settings.get("tokenName")).trim() {
            "" => "Token".to_string(),
            name => name.to_string(),
        };
        let token = match oauth2_tokens::usable_named(&self.vault, &name, now).await {
            Ok(Some(token)) => token,
            _ if oauth2::uses_browser(&settings) => return,
            _ => {
                let Ok(request) = oauth2::token_request(&settings, oauth2::Exchange::New) else {
                    return;
                };
                let restricted =
                    secret_hosts::referenced_by(&secret_hosts::restricted(payload), &stored);
                let Ok(answer) = self.post_token(request, &restricted).await else {
                    return;
                };
                let Ok(token) = oauth2_tokens::store(&self.vault, &name, &answer).await else {
                    return;
                };
                token
            }
        };
        let Some(id) = token["id"].as_str() else {
            return;
        };
        let Ok(details) = oauth2_tokens::details(&self.vault, id).await else {
            return;
        };
        // This send uses the token: its vault reference, resolved and redacted like the others.
        let source = auth::text(values.get("tokenSource"));
        if let Some(target) = payload.pointer_mut(pointer) {
            set_auth_value(
                target,
                "accessToken",
                json!(oauth2_tokens::reference(id, &source)),
            );
            set_auth_value(target, "oauth2TokenId", json!(id));
        }
        if !payload["resolvedSecrets"].is_object() {
            payload["resolvedSecrets"] = json!({});
        }
        let access = details["accessToken"]
            .as_str()
            .or(details["idToken"].as_str());
        for (key, value) in [
            (format!("nexo-oauth2:{id}"), access),
            (format!("nexo-oauth2-id:{id}"), details["idToken"].as_str()),
        ] {
            if let Some(value) = value {
                payload["resolvedSecrets"][key] = json!(value);
            }
        }
    }
}
