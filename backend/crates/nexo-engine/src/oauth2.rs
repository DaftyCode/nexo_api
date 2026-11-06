//! OAuth 2.0 token requests ("Get New Access Token" and refresh), with the settings Postman
//! stores in `auth.oauth2` and the extra ones of Insomnia and Bruno.
//!
//! The request each grant sends follows Insomnia's `o-auth-2/get-token.ts`: the client
//! authenticates with a Basic header unless its credentials go in the body, custom
//! parameters go to the body, the URL or a header, and the answer may be JSON or a form.
use aws_lc_rs::digest;
use base64::{
    Engine as _,
    engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD},
};
use nexo_domain::{Error, Result};
use serde_json::{Map, Value, json};
use url::Url;

use crate::auth::text;

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
fn token_fields(status: u16, fields: &Map<String, Value>, now_ms: u64) -> Result<Value> {
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

/// Nexo's callback page, the counterpart of Postman's `https://oauth.pstmn.io/v1/browser-callback`.
/// It forwards the provider's answer to the one-time port on this computer named in `state`.
pub const RELAY_URL: &str = "https://daftycode.github.io/nexo_api/oauth/callback";

/// How the provider's answer comes back to Nexo.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Callback {
    /// The Callback URL is on this computer: Nexo listens on it.
    Loopback(Url),
    /// "Authorize using browser": Nexo's callback page forwards the answer to a local port.
    Relay,
    /// Any other Callback URL: the user pastes the address the browser returned to.
    Manual(Url),
}

fn enabled(auth: &Map<String, Value>, key: &str) -> bool {
    matches!(auth.get(key), Some(Value::Bool(true))) || text(auth.get(key)) == "true"
}

/// Whether a grant type signs in through the browser.
pub fn uses_browser(auth: &Map<String, Value>) -> bool {
    matches!(
        grant(auth).as_str(),
        "authorization_code" | "authorization_code_with_pkce" | "implicit"
    )
}

/// The callback mode, as Postman's options map to Nexo: "Authorize using browser" uses Nexo's
/// callback page; otherwise the Callback URL decides.
pub fn callback(auth: &Map<String, Value>) -> Result<Callback> {
    if enabled(auth, "useBrowser") {
        return Ok(Callback::Relay);
    }
    let redirect = non_empty(auth, "redirect_uri")
        .ok_or_else(|| invalid("Enter the Callback URL or select Authorize using browser"))?;
    let url = Url::parse(&redirect)
        .map_err(|_| invalid(format!("The Callback URL is not valid: {redirect}")))?;
    let loopback = url.scheme() == "http"
        && matches!(url.host_str(), Some("127.0.0.1" | "localhost" | "[::1]"));
    Ok(if loopback {
        Callback::Loopback(url)
    } else {
        Callback::Manual(url)
    })
}

/// The PKCE code verifier: the one entered, or a new random one (RFC 7636).
pub fn pkce_verifier(auth: &Map<String, Value>, random: &[u8]) -> Result<Option<String>> {
    if grant(auth) != "authorization_code_with_pkce" {
        return Ok(None);
    }
    match non_empty(auth, "code_verifier") {
        Some(verifier) => {
            let valid = (43..=128).contains(&verifier.len())
                && verifier
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"-._~".contains(&b));
            if !valid {
                return Err(invalid(
                    "The Code Verifier must have 43 to 128 letters, digits or - . _ ~",
                ));
            }
            Ok(Some(verifier))
        }
        None => Ok(Some(URL_SAFE_NO_PAD.encode(random))),
    }
}

/// The PKCE `(code_challenge, code_challenge_method)` for a verifier.
pub fn pkce_challenge(auth: &Map<String, Value>, verifier: &str) -> (String, &'static str) {
    if text(auth.get("challengeAlgorithm")).eq_ignore_ascii_case("plain") {
        (verifier.to_string(), "plain")
    } else {
        (
            URL_SAFE_NO_PAD.encode(digest::digest(&digest::SHA256, verifier.as_bytes())),
            "S256",
        )
    }
}

/// The address that starts the sign-in in the browser.
pub fn authorization_url(
    auth: &Map<String, Value>,
    redirect_uri: &str,
    state: &str,
    challenge: Option<&(String, &'static str)>,
    nonce: Option<&str>,
) -> Result<Url> {
    let address = non_empty(auth, "authUrl").ok_or_else(|| invalid("Enter the Auth URL"))?;
    let mut url = Url::parse(&address)
        .map_err(|_| invalid(format!("The Auth URL is not valid: {address}")))?;
    if !["http", "https"].contains(&url.scheme()) {
        return Err(invalid("The Auth URL must use HTTP or HTTPS"));
    }
    let response_type = if grant(auth) == "implicit" {
        non_empty(auth, "responseType").unwrap_or_else(|| "token".into())
    } else {
        "code".into()
    };
    {
        let mut query = url.query_pairs_mut();
        query.append_pair("response_type", &response_type);
        query.append_pair("client_id", &text(auth.get("clientId")));
        query.append_pair("redirect_uri", redirect_uri);
        for key in ["scope", "audience", "resource"] {
            if let Some(value) = non_empty(auth, key) {
                query.append_pair(key, &value);
            }
        }
        query.append_pair("state", state);
        if let Some((code_challenge, method)) = challenge {
            query.append_pair("code_challenge", code_challenge);
            query.append_pair("code_challenge_method", method);
        }
        if let Some(nonce) = nonce.filter(|_| response_type.contains("id_token")) {
            query.append_pair("nonce", nonce);
        }
        // Headers cannot be sent through a browser, so every custom parameter goes in the URL.
        for row in auth
            .get("authRequestParams")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            let key = text(row.get("key")).trim().to_string();
            if !key.is_empty() && row["enabled"] != false && row["disabled"] != true {
                query.append_pair(&key, &text(row.get("value")));
            }
        }
    }
    Ok(url)
}

/// What came back to the redirect URI.
#[derive(Debug, PartialEq)]
pub enum Returned {
    /// An authorization code to exchange for a token.
    Code(String),
    /// A token, from the implicit grant.
    Token(Value),
}

/// Reads the parameters the provider returned, in the query or (implicit grant) the
/// fragment, and checks that `state` is the one this sign-in sent.
pub fn read_return(
    query: &[(String, String)],
    expected_state: &str,
    now_ms: u64,
) -> Result<Returned> {
    let fields: Map<String, Value> = query
        .iter()
        .map(|(k, v)| (k.clone(), Value::String(v.clone())))
        .collect();
    let get = |key: &str| {
        fields
            .get(key)
            .and_then(Value::as_str)
            .filter(|v| !v.is_empty())
    };
    if let Some(error) = get("error") {
        let description = get("error_description")
            .map(|d| format!(": {d}"))
            .unwrap_or_default();
        return Err(invalid(format!(
            "The sign-in was refused ({error}){description}"
        )));
    }
    if get("state").unwrap_or("") != expected_state {
        return Err(invalid(
            "The answer does not belong to this sign-in (state mismatch)",
        ));
    }
    if let Some(code) = get("code") {
        return Ok(Returned::Code(code.to_string()));
    }
    token_fields(200, &fields, now_ms).map(Returned::Token)
}

/// The query and fragment parameters of an address the browser returned to.
pub fn returned_parameters(url: &Url) -> Vec<(String, String)> {
    let mut parameters: Vec<(String, String)> = url
        .query_pairs()
        .map(|(k, v)| (k.into_owned(), v.into_owned()))
        .collect();
    if let Some(fragment) = url.fragment() {
        parameters.extend(
            url::form_urlencoded::parse(fragment.as_bytes())
                .map(|(k, v)| (k.into_owned(), v.into_owned())),
        );
    }
    parameters
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_a_pasted_token_with_its_expiry() {
        // {"sub":"ada","exp":2000000000}
        let jwt = format!(
            "eyJhbGciOiJIUzI1NiJ9.{}.signature",
            URL_SAFE_NO_PAD.encode(r#"{"sub":"ada","exp":2000000000}"#)
        );
        assert_eq!(jwt_expiry(&jwt), Some(2_000_000_000_000));
        assert_eq!(jwt_expiry("opaque-token"), None);
        let fields = |value: Value| value.as_object().cloned().unwrap();
        let token = pasted_token(
            &fields(json!({"accessToken": format!("  Bearer {jwt} "), "refreshToken": "r1"})),
            1_000,
        )
        .unwrap();
        assert_eq!(token["accessToken"], jwt.as_str());
        assert_eq!(token["refreshToken"], "r1");
        assert_eq!(token["expiresAt"], 2_000_000_000_000u64);
        assert_eq!(token["obtainedAt"], 1_000);
        // An opaque token without expiry, or with the expiry given.
        let opaque = pasted_token(&fields(json!({"accessToken": "opaque"})), 1_000).unwrap();
        assert!(opaque["expiresAt"].is_null());
        let given = pasted_token(
            &fields(json!({"accessToken": "opaque", "expiresIn": 60})),
            1_000,
        )
        .unwrap();
        assert_eq!(given["expiresAt"], 61_000);
        assert!(pasted_token(&fields(json!({"refreshToken": "r1"})), 1_000).is_err());
        assert!(pasted_token(&fields(json!({"accessToken": "  "})), 1_000).is_err());
    }

    fn auth(entries: Value) -> Map<String, Value> {
        crate::auth::values(&json!({"type": "oauth2", "oauth2": entries}))
    }
    fn form(request: &TokenRequest) -> Vec<(&str, &str)> {
        request
            .form
            .iter()
            .map(|(k, v)| (k.as_str(), v.as_str()))
            .collect()
    }
    fn header<'a>(request: &'a TokenRequest, name: &str) -> Option<&'a str> {
        request
            .headers
            .iter()
            .find(|(k, _)| k == name)
            .map(|(_, v)| v.as_str())
    }

    #[test]
    fn client_credentials_authenticate_with_a_basic_header_by_default() {
        let request = token_request(
            &auth(json!([
                {"key": "grant_type", "value": "client_credentials"},
                {"key": "accessTokenUrl", "value": "https://id.test/token"},
                {"key": "clientId", "value": "app"},
                {"key": "clientSecret", "value": "s3cret"},
                {"key": "scope", "value": "read write"},
                {"key": "audience", "value": "api"}
            ])),
            Exchange::New,
        )
        .unwrap();
        assert_eq!(request.url.as_str(), "https://id.test/token");
        assert_eq!(
            form(&request),
            vec![
                ("grant_type", "client_credentials"),
                ("scope", "read write"),
                ("audience", "api")
            ]
        );
        assert_eq!(
            header(&request, "authorization"),
            Some("Basic YXBwOnMzY3JldA==")
        );
    }

    #[test]
    fn password_grant_can_send_client_credentials_in_the_body() {
        let request = token_request(
            &auth(json!([
                {"key": "grant_type", "value": "password_credentials"},
                {"key": "accessTokenUrl", "value": "https://id.test/token"},
                {"key": "username", "value": "ada"},
                {"key": "password", "value": "pw"},
                {"key": "clientId", "value": "app"},
                {"key": "client_authentication", "value": "body"},
                {"key": "origin", "value": "https://app.test"}
            ])),
            Exchange::New,
        )
        .unwrap();
        assert_eq!(
            form(&request),
            vec![
                ("grant_type", "password"),
                ("username", "ada"),
                ("password", "pw"),
                ("client_id", "app")
            ]
        );
        assert_eq!(header(&request, "authorization"), None);
        assert_eq!(header(&request, "origin"), Some("https://app.test"));
    }

    #[test]
    fn custom_parameters_go_to_the_body_the_url_or_a_header() {
        let request = token_request(
            &auth(json!([
                {"key": "grant_type", "value": "client_credentials"},
                {"key": "accessTokenUrl", "value": "https://id.test/token?tenant=1"},
                {"key": "tokenRequestParams", "value": [
                    {"key": "resource", "value": "api://x", "enabled": true, "send_as": "request_body"},
                    {"key": "region", "value": "eu", "enabled": true, "send_as": "request_url"},
                    {"key": "X-Trace", "value": "1", "enabled": true, "send_as": "request_header"},
                    {"key": "skipped", "value": "no", "enabled": false, "send_as": "request_body"},
                    {"key": "bruno", "value": "yes", "enabled": true, "sendIn": "queryparams"}
                ]}
            ])), Exchange::New)
        .unwrap();
        assert!(form(&request).contains(&("resource", "api://x")));
        assert!(!form(&request).iter().any(|(k, _)| *k == "skipped"));
        assert_eq!(
            request.url.as_str(),
            "https://id.test/token?tenant=1&region=eu&bruno=yes"
        );
        assert_eq!(header(&request, "x-trace"), Some("1"));
    }

    #[test]
    fn refreshing_uses_the_refresh_url_and_its_own_parameters() {
        let settings = auth(json!([
            {"key": "grant_type", "value": "authorization_code_with_pkce"},
            {"key": "accessTokenUrl", "value": "https://id.test/token"},
            {"key": "refreshTokenUrl", "value": "https://id.test/refresh"},
            {"key": "scope", "value": "openid"},
            {"key": "refreshRequestParams", "value": [
                {"key": "origin", "value": "http://localhost", "enabled": true, "send_as": "request_header"}
            ]}
        ]));
        let request = token_request(&settings, Exchange::Refresh("r1")).unwrap();
        assert_eq!(request.url.as_str(), "https://id.test/refresh");
        assert_eq!(
            form(&request),
            vec![
                ("grant_type", "refresh_token"),
                ("refresh_token", "r1"),
                ("scope", "openid")
            ]
        );
        assert_eq!(header(&request, "origin"), Some("http://localhost"));
    }

    #[test]
    fn reports_missing_urls_and_browser_grants_clearly() {
        let error = token_request(
            &auth(json!([{"key": "grant_type", "value": "client_credentials"}])),
            Exchange::New,
        )
        .unwrap_err();
        assert!(error.to_string().contains("Access Token URL"));
        let error = token_request(
            &auth(json!([{"key": "grant_type", "value": "implicit"}])),
            Exchange::New,
        )
        .unwrap_err();
        assert!(error.to_string().contains("browser"));
    }

    #[test]
    fn reads_json_and_form_answers_and_reports_errors() {
        let token = token_response(
            200,
            r#"{"access_token":"a","refresh_token":"r","token_type":"Bearer","expires_in":3600}"#,
            1_000,
        )
        .unwrap();
        assert_eq!(token["accessToken"], "a");
        assert_eq!(token["refreshToken"], "r");
        assert_eq!(token["expiresAt"], 3_601_000);

        let token = token_response(200, "access_token=b&expires_in=60", 0).unwrap();
        assert_eq!(token["accessToken"], "b");
        assert_eq!(token["expiresAt"], 60_000);

        let error = token_response(
            400,
            r#"{"error":"invalid_client","error_description":"bad secret"}"#,
            0,
        )
        .unwrap_err();
        assert!(error.to_string().contains("invalid_client"));
        assert!(error.to_string().contains("bad secret"));
        assert!(token_response(200, "{}", 0).is_err());
        assert!(token_response(500, "oops", 0).is_err());
    }

    #[test]
    fn pkce_matches_the_rfc_7636_example() {
        let settings = auth(json!([
            {"key": "grant_type", "value": "authorization_code_with_pkce"},
            {"key": "code_verifier", "value": "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"}
        ]));
        let verifier = pkce_verifier(&settings, &[0; 48]).unwrap().unwrap();
        assert_eq!(
            pkce_challenge(&settings, &verifier),
            (
                "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM".to_string(),
                "S256"
            )
        );
        // Left blank, a 64-character verifier is generated; plain sends it as the challenge.
        let generated = auth(json!([
            {"key": "grant_type", "value": "authorization_code_with_pkce"},
            {"key": "challengeAlgorithm", "value": "plain"}
        ]));
        let verifier = pkce_verifier(&generated, &[7; 48]).unwrap().unwrap();
        assert_eq!(verifier.len(), 64);
        assert_eq!(pkce_challenge(&generated, &verifier).0, verifier);
        let short = auth(json!([
            {"key": "grant_type", "value": "authorization_code_with_pkce"},
            {"key": "code_verifier", "value": "too-short"}
        ]));
        assert!(pkce_verifier(&short, &[0; 48]).is_err());
        let plain_code = auth(json!([{"key": "grant_type", "value": "authorization_code"}]));
        assert_eq!(pkce_verifier(&plain_code, &[0; 48]).unwrap(), None);
    }

    #[test]
    fn chooses_the_callback_mode_like_postman_options() {
        let mode = |rows: Value| callback(&auth(rows));
        assert_eq!(
            mode(json!([{"key": "useBrowser", "value": true}])).unwrap(),
            Callback::Relay
        );
        assert!(matches!(
            mode(json!([{"key": "redirect_uri", "value": "http://localhost:8080/cb"}])).unwrap(),
            Callback::Loopback(_)
        ));
        assert!(matches!(
            mode(json!([{"key": "redirect_uri", "value": "https://oauth.pstmn.io/v1/browser-callback"}])).unwrap(),
            Callback::Manual(_)
        ));
        assert!(mode(json!([])).is_err());
    }

    #[test]
    fn builds_the_authorization_address() {
        let settings = auth(json!([
            {"key": "grant_type", "value": "authorization_code_with_pkce"},
            {"key": "authUrl", "value": "https://id.test/authorize?tenant=a"},
            {"key": "clientId", "value": "app"},
            {"key": "scope", "value": "openid profile"},
            {"key": "authRequestParams", "value": [
                {"key": "prompt", "value": "login", "enabled": true, "send_as": "request_url"},
                {"key": "off", "value": "x", "enabled": false}
            ]}
        ]));
        let challenge = ("c".to_string(), "S256");
        let url = authorization_url(
            &settings,
            "http://localhost/cb",
            "s1",
            Some(&challenge),
            None,
        )
        .unwrap();
        let query: Vec<(String, String)> = url
            .query_pairs()
            .map(|(k, v)| (k.into(), v.into()))
            .collect();
        let get = |key: &str| {
            query
                .iter()
                .find(|(k, _)| k == key)
                .map(|(_, v)| v.as_str())
        };
        assert_eq!(get("tenant"), Some("a"));
        assert_eq!(get("response_type"), Some("code"));
        assert_eq!(get("client_id"), Some("app"));
        assert_eq!(get("redirect_uri"), Some("http://localhost/cb"));
        assert_eq!(get("scope"), Some("openid profile"));
        assert_eq!(get("state"), Some("s1"));
        assert_eq!(get("code_challenge"), Some("c"));
        assert_eq!(get("code_challenge_method"), Some("S256"));
        assert_eq!(get("prompt"), Some("login"));
        assert_eq!(get("off"), None);

        let implicit = auth(json!([
            {"key": "grant_type", "value": "implicit"},
            {"key": "authUrl", "value": "https://id.test/authorize"},
            {"key": "responseType", "value": "id_token token"}
        ]));
        let url =
            authorization_url(&implicit, "http://localhost/cb", "s", None, Some("n1")).unwrap();
        assert!(url.as_str().contains("response_type=id_token+token"));
        assert!(url.as_str().contains("nonce=n1"));
    }

    #[test]
    fn reads_codes_tokens_and_errors_returned_to_the_callback() {
        let pairs = |text: &str| -> Vec<(String, String)> {
            returned_parameters(&Url::parse(text).unwrap())
        };
        assert_eq!(
            read_return(&pairs("http://l/cb?code=abc&state=s1"), "s1", 0).unwrap(),
            Returned::Code("abc".into())
        );
        let Returned::Token(token) = read_return(
            &pairs("http://l/cb#access_token=t&state=s1&expires_in=10"),
            "s1",
            0,
        )
        .unwrap() else {
            panic!("expected a token")
        };
        assert_eq!(token["accessToken"], "t");
        assert_eq!(token["expiresAt"], 10_000);
        let refused = read_return(
            &pairs("http://l/cb?error=access_denied&error_description=No&state=s1"),
            "s1",
            0,
        );
        assert!(refused.unwrap_err().to_string().contains("access_denied"));
        let forged = read_return(&pairs("http://l/cb?code=abc&state=other"), "s1", 0);
        assert!(forged.unwrap_err().to_string().contains("state"));
    }

    #[test]
    fn exchanges_the_code_with_the_verifier_and_redirect_uri() {
        let settings = auth(json!([
            {"key": "grant_type", "value": "authorization_code_with_pkce"},
            {"key": "accessTokenUrl", "value": "https://id.test/token"},
            {"key": "clientId", "value": "app"},
            {"key": "client_authentication", "value": "body"}
        ]));
        let request = token_request(
            &settings,
            Exchange::Code {
                code: "abc",
                redirect_uri: "http://localhost/cb",
                verifier: Some("v"),
            },
        )
        .unwrap();
        assert_eq!(
            form(&request),
            vec![
                ("grant_type", "authorization_code"),
                ("code", "abc"),
                ("redirect_uri", "http://localhost/cb"),
                ("code_verifier", "v"),
                ("client_id", "app")
            ]
        );
    }
}
