//! Requests to token endpoints: OAuth 1.0 `oauth.token` and the OAuth 2.0 grants, sent
//! only to the hosts their secrets allow.
use super::*;

impl Engine {
    /// The allowed hosts of the restricted vault secrets a payload resolved, as
    /// `secretHosts`. Only the engine sets it: the application discards it from clients.
    pub(super) async fn with_secret_hosts(&self, mut payload: Value) -> Result<Value> {
        let Some(resolved) = payload["resolvedSecrets"]
            .as_object()
            .filter(|secrets| !secrets.is_empty())
        else {
            return Ok(payload);
        };
        let hosts = self.vault.hosts().await?;
        let restricted: Map<String, Value> = resolved
            .keys()
            .filter_map(|name| {
                let allowed = hosts.get(name).filter(|allowed| !allowed.is_empty())?;
                Some((name.clone(), json!(allowed)))
            })
            .collect();
        if !restricted.is_empty() {
            payload["secretHosts"] = Value::Object(restricted);
        }
        Ok(payload)
    }
    /// Sends a token request and reads the answer. `restricted` are the vault secrets of the
    /// settings it comes from that may only go to some hosts.
    pub(super) async fn post_token(
        &self,
        request: oauth2::TokenRequest,
        restricted: &[secret_hosts::Restricted],
    ) -> Result<Value> {
        secret_hosts::check_token_request(restricted, &request)?;
        let client = self.client_for(&request.url).await?;
        let mut builder = client.post(request.url.clone());
        for (name, value) in &request.headers {
            builder = builder.header(name, value);
        }
        let body = url::form_urlencoded::Serializer::new(String::new())
            .extend_pairs(&request.form)
            .finish();
        let response = builder
            .header("content-type", "application/x-www-form-urlencoded")
            .body(body)
            .send()
            .await
            .map_err(transport::request_error)?;
        if response.status().is_redirection() {
            return Err(invalid("The token endpoint answered with a redirect"));
        }
        let status = response.status().as_u16();
        let text = read_limited(response, 1024 * 1024).await?;
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|elapsed| elapsed.as_millis() as u64)
            .unwrap_or_default();
        oauth2::token_response(status, &text, now)
    }
    pub(super) async fn oauth_token(&self, payload: &Value) -> Result<Value> {
        let url = payload["url"]
            .as_str()
            .and_then(|url| url::Url::parse(url).ok())
            .ok_or_else(|| invalid("Enter the full token endpoint URL"))?;
        if !["http", "https"].contains(&url.scheme()) {
            return Err(invalid("HTTP token endpoint required"));
        }
        let form = {
            let mut form = url::form_urlencoded::Serializer::new(String::new());
            for (key, value) in payload["fields"].as_object().into_iter().flatten() {
                let value = match value {
                    Value::Null => continue,
                    Value::String(text) if text.is_empty() => continue,
                    Value::String(text) => text.clone(),
                    other => other.to_string(),
                };
                form.append_pair(key, &value);
            }
            form.finish()
        };
        let client = self.client_for(&url).await?;
        let mut request = client.post(url);
        for (key, value) in header_pairs(&payload["headers"]) {
            request = request.header(key, value);
        }
        let response = request
            .header("content-type", "application/x-www-form-urlencoded")
            .header("accept", "application/json")
            .body(form)
            .send()
            .await
            .map_err(transport::request_error)?;
        if response.status().is_redirection() {
            return Err(invalid("The token endpoint answered with a redirect"));
        }
        let status = response.status().as_u16();
        let text = read_limited(response, 1024 * 1024).await?;
        let body = serde_json::from_str::<Value>(&text).unwrap_or_else(|_| {
            let fields: Map<String, Value> = url::form_urlencoded::parse(text.as_bytes())
                .map(|(k, v)| (k.into_owned(), Value::String(v.into_owned())))
                .collect();
            if fields.is_empty() || text.to_lowercase().contains("<html") {
                json!({"text": text})
            } else {
                Value::Object(fields)
            }
        });
        Ok(json!({"status": status, "body": body}))
    }
}
