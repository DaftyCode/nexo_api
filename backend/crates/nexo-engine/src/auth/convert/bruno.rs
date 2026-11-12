//! Bruno authentication as a Postman authorization.
use super::*;

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
pub(super) fn bruno_parameters(rows: &Value) -> Value {
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

pub(super) fn bruno_oauth2(oauth2: &Value) -> Value {
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
