use super::*;
use crate::auth::values;

/// The stored rows as one map, as the engine reads them.
fn read(auth: Option<Value>) -> (String, Map<String, Value>) {
    let auth = auth.unwrap();
    let kind = auth["type"].as_str().unwrap().to_string();
    let mut map = values(&auth);
    map.remove("type");
    map.remove(&kind);
    (kind, map)
}

#[test]
fn converts_every_insomnia_type() {
    assert_eq!(from_insomnia(&json!({})), None);
    assert_eq!(
        from_insomnia(&json!({"type": "basic", "disabled": true, "username": "a"})),
        Some(json!({"type": "noauth"}))
    );
    let (kind, map) = read(from_insomnia(&json!({
        "type": "iam", "accessKeyId": "AKID", "secretAccessKey": "s", "region": "eu-west-1",
    })));
    assert_eq!(kind, "awsv4");
    assert_eq!(map["accessKey"], "AKID");
    assert_eq!(map["secretKey"], "s");
    assert!(!map.contains_key("sessionToken"));

    let (kind, map) = read(from_insomnia(&json!({
        "type": "hawk", "id": "i", "key": "k", "algorithm": "sha1", "validatePayload": true,
    })));
    assert_eq!(kind, "hawk");
    assert_eq!(
        (map["authId"].clone(), map["authKey"].clone()),
        (json!("i"), json!("k"))
    );
    assert_eq!(map["includePayloadHash"], true);

    let (_, map) = read(from_insomnia(&json!({
        "type": "asap", "issuer": "iss", "audience": "aud", "keyId": "kid",
        "privateKey": "pem", "additionalClaims": "{\"a\":1}",
    })));
    assert_eq!(map["iss"], "iss");
    assert_eq!(map["kid"], "kid");
    assert_eq!(map["claims"], "{\"a\":1}");

    let (_, map) = read(from_insomnia(&json!({
        "type": "apikey", "key": "session", "value": "abc", "addTo": "cookie",
    })));
    assert_eq!(
        (map["key"].clone(), map["value"].clone()),
        (json!("Cookie"), json!("session=abc"))
    );
    let (_, map) = read(from_insomnia(
        &json!({"type": "apikey", "key": "k", "value": "v", "addTo": "queryParams"}),
    ));
    assert_eq!(map["in"], "query");

    let (_, map) = read(from_insomnia(&json!({
        "type": "oauth1", "consumerKey": "ck", "tokenKey": "tk", "signatureMethod": "RSA-SHA1",
    })));
    assert_eq!(map["token"], "tk");
    assert_eq!(map["addParamsToHeader"], true);

    assert_eq!(read(from_insomnia(&json!({"type": "netrc"}))).0, "netrc");
    assert_eq!(
        read(from_insomnia(&json!({"type": "singleToken", "token": "t"}))).1["token"],
        "t"
    );
    // An unknown type keeps its settings.
    let (kind, map) = read(from_insomnia(&json!({"type": "vendor", "secret": "x"})));
    assert_eq!(
        (kind.as_str(), map["secret"].clone()),
        ("vendor", json!("x"))
    );
}

#[test]
fn converts_insomnia_oauth2_to_postman_keys() {
    let (kind, map) = read(from_insomnia(&json!({
        "type": "oauth2", "grantType": "authorization_code", "usePkce": true,
        "pkceMethod": "S256", "authorizationUrl": "https://sso/auth",
        "accessTokenUrl": "https://sso/token", "clientId": "app", "redirectUrl": "http://localhost:8080/cb",
        "credentialsInBody": true, "tokenPrefix": "Token", "useDefaultBrowser": true,
        "audience": "api", "origin": "http://localhost",
    })));
    assert_eq!(kind, "oauth2");
    for (key, value) in [
        ("grant_type", json!("authorization_code_with_pkce")),
        ("challengeAlgorithm", json!("S256")),
        ("authUrl", json!("https://sso/auth")),
        ("redirect_uri", json!("http://localhost:8080/cb")),
        ("client_authentication", json!("body")),
        ("headerPrefix", json!("Token")),
        ("useBrowser", json!(true)),
        ("audience", json!("api")),
        ("origin", json!("http://localhost")),
    ] {
        assert_eq!(map[key], value, "{key}");
    }
    assert_eq!(
        read(from_insomnia(
            &json!({"type": "oauth2", "grantType": "password"})
        ))
        .1["grant_type"],
        "password_credentials"
    );
}

#[test]
fn converts_every_bruno_mode() {
    assert_eq!(from_bruno(&json!({"mode": "inherit"})), None);
    assert_eq!(
        from_bruno(&json!({"mode": "none"})),
        Some(json!({"type": "noauth"}))
    );
    let (kind, map) = read(from_bruno(&json!({
        "mode": "ntlm", "ntlm": {"username": "u", "password": "p", "domain": "CORP"},
    })));
    assert_eq!(
        (kind.as_str(), map["domain"].clone()),
        ("ntlm", json!("CORP"))
    );
    let (kind, map) = read(from_bruno(
        &json!({"mode": "wsse", "wsse": {"username": "u", "password": "p"}}),
    ));
    assert_eq!(
        (kind.as_str(), map["username"].clone()),
        ("wsse", json!("u"))
    );
    let (_, map) = read(from_bruno(&json!({
        "mode": "apikey", "apikey": {"key": "k", "value": "v", "placement": "queryparams"},
    })));
    assert_eq!(map["in"], "query");
    let (kind, map) = read(from_bruno(&json!({
        "mode": "awsv4", "awsv4": {"accessKeyId": "AKID", "secretAccessKey": "s", "profileName": "dev"},
    })));
    assert_eq!(
        (
            kind.as_str(),
            map["accessKey"].clone(),
            map["profileName"].clone()
        ),
        ("awsv4", json!("AKID"), json!("dev"))
    );
    let (_, map) = read(from_bruno(&json!({
        "mode": "oauth1", "oauth1": {"accessToken": "t", "accessTokenSecret": "ts", "callbackUrl": "cb", "placement": "header"},
    })));
    assert_eq!(
        (
            map["token"].clone(),
            map["tokenSecret"].clone(),
            map["callback"].clone()
        ),
        (json!("t"), json!("ts"), json!("cb"))
    );
    assert_eq!(map["addParamsToHeader"], true);
    let (kind, map) = read(from_bruno(&json!({
        "mode": "akamai-edgegrid", "akamaiEdgegrid": {"accessToken": "a", "clientToken": "c", "clientSecret": "s", "maxBodySize": 1024},
    })));
    assert_eq!(
        (kind.as_str(), map["maxBodySize"].clone()),
        ("edgegrid", json!(1024))
    );
}

#[test]
fn converts_bruno_oauth2_with_its_parameters() {
    let (_, map) = read(from_bruno(&json!({"mode": "oauth2", "oauth2": {
        "grantType": "authorization_code", "pkce": true,
        "callbackUrl": "http://localhost/cb", "authorizationUrl": "https://sso/auth",
        "credentialsPlacement": "basic_auth_header", "credentialsId": "work",
        "tokenPlacement": "url", "tokenQueryKey": "token", "tokenSource": "id_token",
        "autoRefreshToken": true,
        "additionalParameters": {
            "authorization": [{"name": "prompt", "value": "login", "sendIn": "queryparams", "enabled": true}],
            "token": [{"name": "X-Trace", "value": "1", "sendIn": "headers", "enabled": false}],
        },
    }})));
    for (key, value) in [
        ("grant_type", json!("authorization_code_with_pkce")),
        ("redirect_uri", json!("http://localhost/cb")),
        ("authUrl", json!("https://sso/auth")),
        ("client_authentication", json!("header")),
        ("tokenName", json!("work")),
        ("addTokenTo", json!("queryParams")),
        ("tokenQueryKey", json!("token")),
        ("tokenSource", json!("id_token")),
        ("autoRefreshToken", json!(true)),
    ] {
        assert_eq!(map[key], value, "{key}");
    }
    assert_eq!(
        map["authRequestParams"],
        json!([{"key": "prompt", "value": "login", "enabled": true, "send_as": "request_url"}])
    );
    assert_eq!(
        map["tokenRequestParams"],
        json!([{"key": "X-Trace", "value": "1", "enabled": false, "send_as": "request_header"}])
    );
    assert_eq!(
        read(from_bruno(&json!({"mode": "oauth2", "oauth2": {"grantType": "password", "credentialsPlacement": "body"}}))).1["client_authentication"],
        "body"
    );
}
