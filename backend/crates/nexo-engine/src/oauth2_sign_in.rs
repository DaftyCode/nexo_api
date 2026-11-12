//! "Get New Access Token", "Manage Tokens" and the browser sign-in of OAuth 2.0.
use super::*;

impl Engine {
    /// "Get New Access Token" and token refresh for an OAuth 2.0 authorization. Its settings
    /// are resolved like the request's, so `{{variables}}` and vault secrets apply.
    /// The token is kept in the vault; the answer describes it without its values.
    pub(super) async fn oauth2_token(&self, payload: &Value) -> Result<Value> {
        let auth = runner::resolved_auth(payload)?;
        let restricted = secret_hosts::referenced_by(
            &secret_hosts::restricted(payload),
            &runner::request_auth(payload)?,
        );
        if let Some(id) = payload["tokenId"].as_str().filter(|t| !t.is_empty()) {
            let details = oauth2_tokens::details(&self.vault, id).await?;
            let refresh = details["refreshToken"]
                .as_str()
                .filter(|t| !t.is_empty())
                .ok_or_else(|| invalid("This token has no refresh token"))?;
            let request = oauth2::token_request(&auth, oauth2::Exchange::Refresh(refresh))?;
            let token = self.post_token(request, &restricted).await?;
            return oauth2_tokens::replace(&self.vault, id, &token).await;
        }
        let token = self
            .post_token(
                oauth2::token_request(&auth, oauth2::Exchange::New)?,
                &restricted,
            )
            .await?;
        oauth2_tokens::store(&self.vault, &auth::text(auth.get("tokenName")), &token).await
    }
    /// "Manage Tokens": `list` (without values), `details` (with them) and `delete`.
    pub(super) async fn oauth2_tokens(&self, payload: &Value) -> Result<Value> {
        let id = payload["id"].as_str().unwrap_or_default();
        match payload["action"].as_str().unwrap_or("list") {
            "list" => Ok(json!({"tokens": oauth2_tokens::list(&self.vault).await?})),
            "details" => oauth2_tokens::details(&self.vault, id).await,
            "delete" => {
                oauth2_tokens::delete(&self.vault, id).await?;
                Ok(json!({"deleted": true}))
            }
            // A token the person pasted (the sign-in could not take one by itself).
            "add" => {
                let fields = payload.as_object().cloned().unwrap_or_default();
                let token = oauth2::pasted_token(&fields, now_ms())?;
                oauth2_tokens::store(&self.vault, payload["name"].as_str().unwrap_or(""), &token)
                    .await
            }
            other => Err(invalid(format!("Unknown token action: {other}"))),
        }
    }

    /// Browser sign-ins: `start` (default), then `status` until done, `complete` with the
    /// address the browser returned to (manual mode) or `cancel`.
    pub(super) async fn oauth2_authorize(&self, payload: &Value) -> Result<Value> {
        let session = payload["session"].as_str().unwrap_or_default();
        match payload["action"].as_str().unwrap_or("start") {
            "start" => {
                let auth = runner::resolved_auth(payload)?;
                let relay = std::env::var("NEXO_OAUTH_RELAY_URL")
                    .unwrap_or_else(|_| oauth2::RELAY_URL.to_string());
                let started = self.oauth2_flows.start(auth, &relay).await?;
                if let Err(error) = self.check_sign_in(payload, &started.id) {
                    self.oauth2_flows.remove(&started.id);
                    return Err(error);
                }
                let opened = payload["openBrowser"] != false
                    && oauth2_flow::open_browser(started.authorization_url.as_str());
                Ok(json!({
                    "session": started.id,
                    "authorizationUrl": started.authorization_url.as_str(),
                    "mode": started.mode,
                    "redirectUri": started.redirect_uri,
                    "opened": opened,
                }))
            }
            "complete" => {
                let flow = self.oauth2_flows.get(session)?;
                let pasted = payload["url"].as_str().unwrap_or_default().trim();
                let url = url::Url::parse(pasted)
                    .map_err(|_| invalid("Paste the full address the browser returned to"))?;
                flow.set_returned(oauth2::returned_parameters(&url));
                self.oauth2_progress(session).await
            }
            "status" => self.oauth2_progress(session).await,
            "open" => {
                let flow = self.oauth2_flows.get(session)?;
                Ok(json!({"opened": oauth2_flow::open_browser(flow.authorization_url.as_str())}))
            }
            "cancel" => {
                self.oauth2_flows.remove(session);
                Ok(json!({"state": "cancelled"}))
            }
            other => Err(invalid(format!("Unknown sign-in action: {other}"))),
        }
    }
    /// A browser sign-in may only send restricted vault secrets to hosts they allow: in the
    /// address the browser opens and in the token request that exchanges its code.
    pub(super) fn check_sign_in(&self, payload: &Value, session: &str) -> Result<()> {
        let restricted = secret_hosts::referenced_by(
            &secret_hosts::restricted(payload),
            &runner::request_auth(payload)?,
        );
        if restricted.is_empty() {
            return Ok(());
        }
        let flow = self.oauth2_flows.get(session)?;
        secret_hosts::check_address(&restricted, &flow.authorization_url)?;
        let exchange = oauth2::Exchange::Code {
            code: "",
            redirect_uri: &flow.redirect_uri,
            verifier: flow.verifier.as_deref(),
        };
        match oauth2::token_request(&flow.auth, exchange) {
            Ok(request) => secret_hosts::check_token_request(&restricted, &request),
            // The implicit grant has no token request.
            Err(_) => Ok(()),
        }
    }
    /// Turns the provider's answer into a token once it arrives, and reports the sign-in.
    pub(super) async fn oauth2_progress(&self, session: &str) -> Result<Value> {
        let flow = self.oauth2_flows.get(session)?;
        if flow.outcome().is_none() {
            if let Some(parameters) = flow.take_returned() {
                let obtained = match flow.read(&parameters, now_ms()) {
                    Ok(oauth2::Returned::Token(token)) => Ok(token),
                    Ok(oauth2::Returned::Code(code)) => {
                        let exchange = oauth2::Exchange::Code {
                            code: &code,
                            redirect_uri: &flow.redirect_uri,
                            verifier: flow.verifier.as_deref(),
                        };
                        match oauth2::token_request(&flow.auth, exchange) {
                            // Its secrets were checked when the sign-in started.
                            Ok(request) => self.post_token(request, &[]).await,
                            Err(error) => Err(error),
                        }
                    }
                    Err(error) => Err(error),
                };
                let name = auth::text(flow.auth.get("tokenName"));
                let outcome = match obtained {
                    Ok(token) => oauth2_tokens::store(&self.vault, &name, &token).await,
                    Err(error) => Err(error),
                };
                flow.finish(outcome.map_err(|error| error.to_string()));
            } else if flow.expired() {
                flow.finish(Err(
                    "The sign-in was not completed within five minutes".into()
                ));
            }
        }
        Ok(match flow.outcome() {
            None => json!({"state": "waiting"}),
            Some(Ok(token)) => {
                self.oauth2_flows.remove(session);
                json!({"state": "done", "token": token})
            }
            Some(Err(error)) => {
                self.oauth2_flows.remove(session);
                json!({"state": "error", "error": error})
            }
        })
    }
}
