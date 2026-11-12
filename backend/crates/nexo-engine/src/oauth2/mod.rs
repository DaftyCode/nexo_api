//! OAuth 2.0 token requests ("Get New Access Token" and refresh), with the settings Postman
//! stores in `auth.oauth2` and the extra ones of Insomnia and Bruno.
//!
//! The request each grant sends follows Insomnia's `o-auth-2/get-token.ts`: the client
//! authenticates with a Basic header unless its credentials go in the body, custom
//! parameters go to the body, the URL or a header, and the answer may be JSON or a form.

mod browser;
mod tokens;

use crate::auth::text;
use aws_lc_rs::digest;
use base64::{
    Engine as _,
    engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD},
};
pub use browser::{
    Callback, RELAY_URL, Returned, authorization_url, callback, pkce_challenge, pkce_verifier,
    read_return, returned_parameters, uses_browser,
};
use nexo_domain::{Error, Result};
use serde_json::{Map, Value, json};
use tokens::token_fields;
pub use tokens::{jwt_expiry, pasted_token, token_response};
use url::Url;

/// A token request ready to send: `POST url` with a form body.
#[derive(Debug, PartialEq)]
pub struct TokenRequest {
    pub url: Url,
    pub headers: Vec<(String, String)>,
    pub form: Vec<(String, String)>,
}

fn invalid(message: impl Into<String>) -> Error {
    Error::Validation(message.into())
}

fn non_empty(auth: &Map<String, Value>, key: &str) -> Option<String> {
    Some(text(auth.get(key)))
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

/// Grant types as Postman names them, with Bruno's and Insomnia's names accepted too.
fn grant(auth: &Map<String, Value>) -> String {
    match text(auth.get("grant_type")).as_str() {
        "" => "authorization_code".into(),
        "password" => "password_credentials".into(),
        other => other.into(),
    }
}

/// Where a custom parameter goes. Postman stores `send_as`, Bruno `sendIn`.
enum Place {
    Body,
    Url,
    Header,
}
fn place(row: &Value, default: Place) -> Place {
    let value = row["send_as"].as_str().or_else(|| row["sendIn"].as_str());
    match value.unwrap_or("") {
        "request_body" | "body" => Place::Body,
        "request_url" | "queryparams" | "url" => Place::Url,
        "request_header" | "headers" | "header" => Place::Header,
        _ => default,
    }
}

/// What a token request does.
pub enum Exchange<'a> {
    /// A new token with a grant that needs no browser (client or password credentials).
    New,
    /// Renews a token.
    Refresh(&'a str),
    /// Exchanges the code returned to the redirect URI, with the PKCE verifier if any.
    Code {
        code: &'a str,
        redirect_uri: &'a str,
        verifier: Option<&'a str>,
    },
}

/// Builds the request that obtains, renews or exchanges a token.
pub fn token_request(auth: &Map<String, Value>, exchange: Exchange) -> Result<TokenRequest> {
    let mut form: Vec<(String, String)> = Vec::new();
    let mut add = |key: &str, value: Option<String>| {
        if let Some(value) = value {
            form.push((key.into(), value));
        }
    };
    let (endpoint, params) = if let Exchange::Refresh(token) = exchange {
        add("grant_type", Some("refresh_token".into()));
        add("refresh_token", Some(token.into()));
        add("scope", non_empty(auth, "scope"));
        let url = non_empty(auth, "refreshTokenUrl").or_else(|| non_empty(auth, "accessTokenUrl"));
        (url, "refreshRequestParams")
    } else if let Exchange::Code {
        code,
        redirect_uri,
        verifier,
    } = exchange
    {
        add("grant_type", Some("authorization_code".into()));
        add("code", Some(code.into()));
        add("redirect_uri", Some(redirect_uri.into()));
        add("audience", non_empty(auth, "audience"));
        add("resource", non_empty(auth, "resource"));
        add("code_verifier", verifier.map(str::to_string));
        (non_empty(auth, "accessTokenUrl"), "tokenRequestParams")
    } else {
        match grant(auth).as_str() {
            "client_credentials" => {
                add("grant_type", Some("client_credentials".into()));
                add("scope", non_empty(auth, "scope"));
                add("audience", non_empty(auth, "audience"));
                add("resource", non_empty(auth, "resource"));
            }
            "password_credentials" => {
                add("grant_type", Some("password".into()));
                add("username", Some(text(auth.get("username"))));
                add("password", Some(text(auth.get("password"))));
                add("scope", non_empty(auth, "scope"));
                add("audience", non_empty(auth, "audience"));
            }
            "authorization_code" | "authorization_code_with_pkce" | "implicit" => {
                return Err(invalid(
                    "This grant type signs in through the browser: use oauth2.authorize",
                ));
            }
            other => {
                return Err(invalid(format!(
                    "Unsupported OAuth 2.0 grant type: {other}"
                )));
            }
        }
        (non_empty(auth, "accessTokenUrl"), "tokenRequestParams")
    };
    let endpoint = endpoint.ok_or_else(|| invalid("Enter the Access Token URL"))?;
    let mut url = Url::parse(&endpoint)
        .map_err(|_| invalid(format!("The Access Token URL is not valid: {endpoint}")))?;
    if !["http", "https"].contains(&url.scheme()) {
        return Err(invalid("The Access Token URL must use HTTP or HTTPS"));
    }
    let mut headers = vec![(
        "accept".to_string(),
        "application/x-www-form-urlencoded, application/json".to_string(),
    )];
    if let Some(origin) = non_empty(auth, "origin") {
        headers.push(("origin".into(), origin));
    }
    let client_id = text(auth.get("clientId"));
    let client_secret = text(auth.get("clientSecret"));
    if text(auth.get("client_authentication")) == "body" {
        if !client_id.is_empty() {
            form.push(("client_id".into(), client_id));
        }
        if !client_secret.is_empty() {
            form.push(("client_secret".into(), client_secret));
        }
    } else if !client_id.is_empty() || !client_secret.is_empty() {
        let basic = STANDARD.encode(format!("{client_id}:{client_secret}"));
        headers.push(("authorization".into(), format!("Basic {basic}")));
    }
    for row in auth
        .get(params)
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let key = text(row.get("key")).trim().to_string();
        if key.is_empty() || row["enabled"] == false || row["disabled"] == true {
            continue;
        }
        let value = text(row.get("value"));
        match place(row, Place::Body) {
            Place::Body => form.push((key, value)),
            Place::Url => {
                url.query_pairs_mut().append_pair(&key, &value);
            }
            Place::Header => headers.push((key.to_lowercase(), value)),
        }
    }
    Ok(TokenRequest { url, headers, form })
}

#[cfg(test)]
mod tests;
