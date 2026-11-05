//! Authorization of Insomnia and Bruno requests in Nexo's (Postman's) stored format,
//! `{type, <type>: [{key, value, type}]}`, for importing their collections (B-07).
//!
//! Each type is renamed to Postman's and its keys to Postman's names, so the editor shows them
//! and exports read like Postman's. `None` means the request inherits its authorization.
//! Mappings checked against Insomnia's `models/request.ts` and Bruno's `bruno-schema` on
//! 2026-11-05.
use serde_json::{Map, Value, json};

/// Postman rows from `(key, value)` pairs, leaving out values that are absent.
fn stored(kind: &str, pairs: Vec<(&str, Value)>) -> Value {
    let rows: Vec<Value> = pairs
        .into_iter()
        .filter(|(_, value)| !value.is_null())
        .map(|(key, value)| {
            let row_type = match &value {
                Value::Bool(_) => "boolean",
                Value::Number(_) => "number",
                Value::Array(_) => "any",
                _ => "string",
            };
            json!({"key": key, "value": value, "type": row_type})
        })
        .collect();
    json!({"type": kind, kind: rows})
}

/// Copies `from` keys of `source` under their Postman names.
fn renamed(source: &Value, keys: &[(&str, &str)]) -> Vec<(String, Value)> {
    keys.iter()
        .map(|(from, to)| (to.to_string(), source[*from].clone()))
        .collect()
}

fn owned(kind: &str, pairs: Vec<(String, Value)>) -> Value {
    stored(
        kind,
        pairs
            .iter()
            .map(|(key, value)| (key.as_str(), value.clone()))
            .collect(),
    )
}

/// Keeps a type Nexo does not know as it was, so that it is neither lost nor misread.
fn unknown(kind: &str, source: &Value) -> Value {
    let values: Map<String, Value> = source.as_object().cloned().unwrap_or_default();
    owned(
        kind,
        values
            .into_iter()
            .filter(|(key, _)| key != "type" && key != "mode")
            .collect(),
    )
}

/// Insomnia's `authentication` object of a request or folder.
pub fn from_insomnia(auth: &Value) -> Option<Value> {
    let kind = auth["type"].as_str().unwrap_or("");
    if kind.is_empty() {
        return None;
    }
    if auth["disabled"] == json!(true) || kind == "none" {
        return Some(json!({"type": "noauth"}));
    }
    Some(match kind {
        "basic" => owned(
            "basic",
            renamed(
                auth,
                &[
                    ("username", "username"),
                    ("password", "password"),
                    ("useISO88591", "useISO88591"),
                ],
            ),
        ),
        "bearer" => owned(
            "bearer",
            renamed(auth, &[("token", "token"), ("prefix", "prefix")]),
        ),
        "singleToken" => owned("bearer", renamed(auth, &[("token", "token")])),
        "digest" | "ntlm" => owned(
            kind,
            renamed(auth, &[("username", "username"), ("password", "password")]),
        ),
        "apikey" => {
            let place = auth["addTo"].as_str().unwrap_or("header");
            if place == "cookie" {
                // Insomnia sends it as a cookie: the same header Postman would write.
                let cookie = format!(
                    "{}={}",
                    auth["key"].as_str().unwrap_or(""),
                    auth["value"].as_str().unwrap_or("")
                );
                stored(
                    "apikey",
                    vec![
                        ("key", json!("Cookie")),
                        ("value", json!(cookie)),
                        ("in", json!("header")),
                    ],
                )
            } else {
                stored(
                    "apikey",
                    vec![
                        ("key", auth["key"].clone()),
                        ("value", auth["value"].clone()),
                        (
                            "in",
                            json!(if place == "queryParams" {
                                "query"
                            } else {
                                "header"
                            }),
                        ),
                    ],
                )
            }
        }
        "oauth1" => {
            let mut pairs = renamed(
                auth,
                &[
                    ("consumerKey", "consumerKey"),
                    ("consumerSecret", "consumerSecret"),
                    ("tokenKey", "token"),
                    ("tokenSecret", "tokenSecret"),
                    ("privateKey", "privateKey"),
                    ("signatureMethod", "signatureMethod"),
                    ("version", "version"),
                    ("nonce", "nonce"),
                    ("timestamp", "timestamp"),
                    ("callback", "callback"),
                    ("realm", "realm"),
                    ("verifier", "verifier"),
                    ("includeBodyHash", "includeBodyHash"),
                ],
            );
            // Insomnia always signs in the Authorization header.
            pairs.push(("addParamsToHeader".into(), json!(true)));
            owned("oauth1", pairs)
        }
        "oauth2" => insomnia_oauth2(auth),
        "hawk" => owned(
            "hawk",
            renamed(
                auth,
                &[
                    ("id", "authId"),
                    ("key", "authKey"),
                    ("algorithm", "algorithm"),
                    ("ext", "extraData"),
                    ("validatePayload", "includePayloadHash"),
                ],
            ),
        ),
        "iam" => owned(
            "awsv4",
            renamed(
                auth,
                &[
                    ("accessKeyId", "accessKey"),
                    ("secretAccessKey", "secretKey"),
                    ("sessionToken", "sessionToken"),
                    ("region", "region"),
                    ("service", "service"),
                ],
            ),
        ),
        "asap" => owned(
            "asap",
            renamed(
                auth,
                &[
                    ("issuer", "iss"),
                    ("subject", "sub"),
                    ("audience", "aud"),
                    ("keyId", "kid"),
                    ("privateKey", "privateKey"),
                    ("additionalClaims", "claims"),
                ],
            ),
        ),
        "netrc" => json!({"type": "netrc", "netrc": []}),
        other => unknown(other, auth),
    })
}

fn insomnia_oauth2(auth: &Value) -> Value {
    let grant = match (auth["grantType"].as_str(), auth["usePkce"] == json!(true)) {
        (Some("authorization_code"), true) => "authorization_code_with_pkce",
        (Some("password"), _) => "password_credentials",
        (Some(grant), _) => grant,
        (None, _) => "authorization_code",
    };
    let mut pairs = vec![("grant_type".to_string(), json!(grant))];
    pairs.extend(renamed(
        auth,
        &[
            ("accessTokenUrl", "accessTokenUrl"),
            ("authorizationUrl", "authUrl"),
            ("clientId", "clientId"),
            ("clientSecret", "clientSecret"),
            ("audience", "audience"),
            ("scope", "scope"),
            ("resource", "resource"),
            ("username", "username"),
            ("password", "password"),
            ("redirectUrl", "redirect_uri"),
            ("useDefaultBrowser", "useBrowser"),
            ("state", "state"),
            ("tokenPrefix", "headerPrefix"),
            ("pkceMethod", "challengeAlgorithm"),
            ("responseType", "responseType"),
            ("origin", "origin"),
        ],
    ));
    if auth["credentialsInBody"] == json!(true) {
        pairs.push(("client_authentication".into(), json!("body")));
    }
    owned("oauth2", pairs)
}

/// Bruno's `auth` object (`{mode, <mode>: {…}}`) of a request, folder or collection.
pub fn from_bruno(auth: &Value) -> Option<Value> {
    let mode = auth["mode"].as_str().unwrap_or("inherit");
    let settings = |key: &str| auth[key].clone();
    Some(match mode {
        "inherit" => return None,
        "none" => json!({"type": "noauth"}),
        "basic" | "digest" | "wsse" => owned(
            mode,
            renamed(
                &settings(mode),
                &[("username", "username"), ("password", "password")],
            ),
        ),
        "ntlm" => owned(
            "ntlm",
            renamed(
                &settings("ntlm"),
                &[
                    ("username", "username"),
                    ("password", "password"),
                    ("domain", "domain"),
                ],
            ),
        ),
        "bearer" => owned(
            "bearer",
            renamed(&settings("bearer"), &[("token", "token")]),
        ),
        "apikey" => {
            let apikey = settings("apikey");
            let place = if apikey["placement"] == json!("queryparams") {
                "query"
            } else {
                "header"
            };
            stored(
                "apikey",
                vec![
                    ("key", apikey["key"].clone()),
                    ("value", apikey["value"].clone()),
                    ("in", json!(place)),
                ],
            )
        }
        "awsv4" => owned(
            "awsv4",
            renamed(
                &settings("awsv4"),
                &[
                    ("accessKeyId", "accessKey"),
                    ("secretAccessKey", "secretKey"),
                    ("sessionToken", "sessionToken"),
                    ("service", "service"),
                    ("region", "region"),
                    ("profileName", "profileName"),
                ],
            ),
        ),
        "oauth1" => {
            let oauth1 = settings("oauth1");
            let mut pairs = renamed(
                &oauth1,
                &[
                    ("consumerKey", "consumerKey"),
                    ("consumerSecret", "consumerSecret"),
                    ("accessToken", "token"),
                    ("accessTokenSecret", "tokenSecret"),
                    ("callbackUrl", "callback"),
                    ("verifier", "verifier"),
                    ("signatureMethod", "signatureMethod"),
                    ("privateKey", "privateKey"),
                    ("privateKeyType", "privateKeyType"),
                    ("timestamp", "timestamp"),
                    ("nonce", "nonce"),
                    ("version", "version"),
                    ("realm", "realm"),
                    ("includeBodyHash", "includeBodyHash"),
                ],
            );
            match oauth1["placement"].as_str() {
                Some("header") => pairs.push(("addParamsToHeader".into(), json!(true))),
                Some(place) => pairs.push(("placement".into(), json!(place))),
                None => {}
            }
            owned("oauth1", pairs)
        }
        "akamai-edgegrid" => owned(
            "edgegrid",
            renamed(
                &settings("akamaiEdgegrid"),
                &[
                    ("accessToken", "accessToken"),
                    ("clientToken", "clientToken"),
                    ("clientSecret", "clientSecret"),
                    ("nonce", "nonce"),
                    ("timestamp", "timestamp"),
                    ("baseURL", "baseURL"),
                    ("headersToSign", "headersToSign"),
                    ("maxBodySize", "maxBodySize"),
                ],
            ),
        ),
        "oauth2" => bruno_oauth2(&settings("oauth2")),
        other => unknown(other, &settings(other)),
    })
}

/// Bruno's custom parameters (`name`, `value`, `sendIn`, `enabled`) as Postman's rows.
fn bruno_parameters(rows: &Value) -> Value {
    Value::Array(
        rows.as_array()
            .into_iter()
            .flatten()
            .map(|row| {
                let place = match row["sendIn"].as_str() {
                    Some("headers") => "request_header",
                    Some("queryparams") => "request_url",
                    _ => "request_body",
                };
                json!({
                    "key": row["name"],
                    "value": row["value"],
                    "enabled": row["enabled"] != json!(false),
                    "send_as": place,
                })
            })
            .collect(),
    )
}

fn bruno_oauth2(oauth2: &Value) -> Value {
    let grant = match (oauth2["grantType"].as_str(), oauth2["pkce"] == json!(true)) {
        (Some("authorization_code"), true) => "authorization_code_with_pkce",
        (Some("password"), _) => "password_credentials",
        (Some(grant), _) => grant,
        (None, _) => "authorization_code",
    };
    let mut pairs = vec![("grant_type".to_string(), json!(grant))];
    pairs.extend(renamed(
        oauth2,
        &[
            ("callbackUrl", "redirect_uri"),
            ("authorizationUrl", "authUrl"),
            ("accessTokenUrl", "accessTokenUrl"),
            ("refreshTokenUrl", "refreshTokenUrl"),
            ("clientId", "clientId"),
            ("clientSecret", "clientSecret"),
            ("scope", "scope"),
            ("state", "state"),
            ("username", "username"),
            ("password", "password"),
            ("credentialsId", "tokenName"),
            ("tokenHeaderPrefix", "headerPrefix"),
            ("tokenQueryKey", "tokenQueryKey"),
            ("tokenSource", "tokenSource"),
            ("autoRefreshToken", "autoRefreshToken"),
            ("autoFetchToken", "autoFetchToken"),
        ],
    ));
    match oauth2["credentialsPlacement"].as_str() {
        Some("body") => pairs.push(("client_authentication".into(), json!("body"))),
        Some(_) => pairs.push(("client_authentication".into(), json!("header"))),
        None => {}
    }
    if let Some(place) = oauth2["tokenPlacement"].as_str() {
        let place = if place == "url" {
            "queryParams"
        } else {
            "header"
        };
        pairs.push(("addTokenTo".into(), json!(place)));
    }
    let additional = &oauth2["additionalParameters"];
    for (from, to) in [
        ("authorization", "authRequestParams"),
        ("token", "tokenRequestParams"),
        ("refresh", "refreshRequestParams"),
    ] {
        if additional[from].is_array() {
            pairs.push((to.into(), bruno_parameters(&additional[from])));
        }
    }
    owned("oauth2", pairs)
}

#[cfg(test)]
mod tests {
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
}
