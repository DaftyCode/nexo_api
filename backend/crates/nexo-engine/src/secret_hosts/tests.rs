use super::*;
use serde_json::json;

fn secret(name: &str, value: &str, hosts: &[&str]) -> Restricted {
    Restricted {
        name: name.into(),
        value: value.into(),
        hosts: AllowedHosts::parse(hosts).unwrap(),
    }
}
fn hop<'a>(host: &'a str, same_origin: bool, credentials: &'a [String]) -> Hop<'a> {
    Hop {
        host,
        same_origin,
        body: true,
        credential_headers: credentials,
        trust_redirect_credentials: false,
    }
}

#[test]
fn reads_the_restricted_secrets_of_a_payload() {
    let payload = json!({
        "resolvedSecrets": {"api": "s3cret", "open": "x"},
        "secretHosts": {"api": ["api.example.com"]},
    });
    let restricted = restricted(&payload);
    assert_eq!(restricted.len(), 1);
    assert_eq!(restricted[0].name, "api");
    assert_eq!(restricted[0].value, "s3cret");
    assert!(restricted[0].hosts.allows("api.example.com"));
}

#[test]
fn finds_where_a_secret_travels() {
    let restricted = [
        secret("api", "v", &["api.example.com"]),
        secret("other", "w", &["x.test"]),
    ];
    let request = json!({
        "method": "POST",
        "url": "https://{{host}}/items?key={{vault:api}}",
        "header": [
            {"key": "X-Token", "value": "{{ vault:api }}"},
            {"key": "Authorization", "value": "Bearer {{vault:api}}"},
            {"key": "X-Off", "value": "{{vault:other}}", "disabled": true},
        ],
        "body": {"mode": "raw", "raw": "{\"k\": \"{{vault:api}}\"}"},
        "auth": {"type": "bearer", "bearer": [{"key": "token", "value": "{{vault:other}}"}]},
    });
    let found = placements(&restricted, &request);
    assert_eq!(found.len(), 2);
    assert_eq!(found[0].headers, ["x-token", "authorization"]);
    assert!(found[0].body && !found[0].auth);
    assert!(found[1].auth && found[1].headers.is_empty() && !found[1].body);
    // Only the URL: still sent to the request's host.
    let url_only = json!({"url": "https://evil.test/?k={{vault:api}}"});
    assert_eq!(placements(&restricted, &url_only).len(), 1);
    // GET sends no body; a reference there goes nowhere.
    let get = json!({"method": "GET", "url": "https://x", "body": {"raw": "{{vault:api}}"}});
    assert!(placements(&restricted, &get).is_empty());
    // Other variables are not vault secrets.
    assert!(placements(&restricted, &json!({"url": "{{api}}"})).is_empty());
}

#[test]
fn checks_each_hop_with_what_it_carries() {
    let restricted = [secret("api", "v", &["api.example.com"])];
    let credentials = vec!["authorization".to_string(), "x-api-key".to_string()];
    let in_header = |key: &str| {
        placements(
            &restricted,
            &json!({"url": "https://api.example.com", "header": [{"key": key, "value": "{{vault:api}}"}]}),
        )
    };
    // The request's own host.
    assert!(
        check_hop(
            &in_header("Authorization"),
            &hop("api.example.com", true, &credentials)
        )
        .is_ok()
    );
    let error = check_hop(
        &in_header("Authorization"),
        &hop("evil.test", true, &credentials),
    )
    .unwrap_err();
    assert_eq!(error.to_string(), "Secret api cannot be sent to evil.test");
    // A redirect elsewhere drops credential headers, but not other headers.
    assert!(
        check_hop(
            &in_header("Authorization"),
            &hop("cdn.test", false, &credentials)
        )
        .is_ok()
    );
    assert!(
        check_hop(
            &in_header("X-Custom"),
            &hop("evil.test", false, &credentials)
        )
        .is_err()
    );
    let mut trusted = hop("evil.test", false, &credentials);
    trusted.trust_redirect_credentials = true;
    assert!(check_hop(&in_header("Authorization"), &trusted).is_err());
    // The body follows 307/308 redirects only.
    let body = placements(
        &restricted,
        &json!({"method": "POST", "url": "https://api.example.com", "body": {"raw": "{{vault:api}}"}}),
    );
    assert!(check_hop(&body, &hop("evil.test", false, &credentials)).is_err());
    let mut without_body = hop("evil.test", false, &credentials);
    without_body.body = false;
    assert!(check_hop(&body, &without_body).is_ok());
}

#[test]
fn checks_oauth2_token_requests_and_addresses() {
    let restricted = [
        secret("cs", "client-s3cret", &["idp.example.com"]),
        secret("at", "tok", &["api.example.com"]),
    ];
    let settings = json!({"type": "oauth2", "oauth2": [
        {"key": "clientSecret", "value": "{{vault:cs}}"},
        {"key": "accessToken", "value": "{{vault:at}}"},
    ]});
    let referenced = referenced_by(&restricted, &settings);
    assert_eq!(
        referenced.len(),
        1,
        "the access token goes to the API, not the provider"
    );
    let token = |url: &str, form: &[(&str, &str)], headers: &[(&str, &str)]| TokenRequest {
        url: Url::parse(url).unwrap(),
        form: form
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect(),
        headers: headers
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect(),
    };
    let in_form = [("client_secret", "client-s3cret")];
    assert!(
        check_token_request(
            &referenced,
            &token("https://idp.example.com/token", &in_form, &[])
        )
        .is_ok()
    );
    assert!(
        check_token_request(
            &referenced,
            &token("https://evil.test/token", &in_form, &[])
        )
        .is_err()
    );
    let basic = format!("Basic {}", STANDARD.encode("app:client-s3cret"));
    assert!(
        check_token_request(
            &referenced,
            &token("https://evil.test/token", &[], &[("Authorization", &basic)])
        )
        .is_err()
    );
    assert!(
        check_token_request(
            &referenced,
            &token("https://evil.test/token", &[("client_id", "app")], &[])
        )
        .is_ok()
    );
    let address = Url::parse("https://login.test/authorize?client_id=app&x=client-s3cret").unwrap();
    assert!(check_address(&referenced, &address).is_err());
    let address = Url::parse("https://login.test/authorize?client_id=app").unwrap();
    assert!(check_address(&referenced, &address).is_ok());
}
