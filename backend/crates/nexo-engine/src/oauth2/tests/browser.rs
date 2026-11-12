//! The browser sign-in: PKCE, the callback, the authorization address and the code exchange.
use super::super::*;
use super::*;

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
        mode(
            json!([{"key": "redirect_uri", "value": "https://oauth.pstmn.io/v1/browser-callback"}])
        )
        .unwrap(),
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
    let url = authorization_url(&implicit, "http://localhost/cb", "s", None, Some("n1")).unwrap();
    assert!(url.as_str().contains("response_type=id_token+token"));
    assert!(url.as_str().contains("nonce=n1"));
}

#[test]
fn reads_codes_tokens_and_errors_returned_to_the_callback() {
    let pairs =
        |text: &str| -> Vec<(String, String)> { returned_parameters(&Url::parse(text).unwrap()) };
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
