mod browser;

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
        ])),
        Exchange::New,
    )
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
