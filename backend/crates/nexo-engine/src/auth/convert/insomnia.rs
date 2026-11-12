//! Insomnia authentication as a Postman authorization.
use super::*;

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

pub(super) fn insomnia_oauth2(auth: &Value) -> Value {
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
