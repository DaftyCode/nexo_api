//! Vault secrets restricted to allowed hosts, like Postman's "allowed domains": where each
//! one travels in a request and whether it may go to a host.
//!
//! Requests: the script context replaces the variables, which never include secrets, and the
//! host then fills the secret references in one pass. A secret only enters a request where
//! its `{{vault:name}}` reference is in the request about to be sent. The reference's
//! field tells where it travels: every field goes to the request's own host, while a
//! redirect to another origin carries only the body (307/308) and the headers that are not
//! credentials (credentials go too with "trust redirect credentials").
//!
//! OAuth 2.0: the secrets referenced by the authorization's settings (except the access token,
//! which goes to the API) are looked for in what is actually sent: the token request, also
//! inside its Basic header, and the authorization address the browser opens.
use crate::oauth2::TokenRequest;
use base64::{Engine as _, engine::general_purpose::STANDARD};
use nexo_domain::{Error, Result, hosts::AllowedHosts};
use serde_json::{Map, Value};
use url::Url;

/// A secret this execution resolved that may only be sent to some hosts.
#[derive(Clone, Debug)]
pub struct Restricted {
    pub name: String,
    pub value: String,
    pub hosts: AllowedHosts,
}

/// The restricted secrets of a payload: `secretHosts`, which only the engine sets.
pub fn restricted(payload: &Value) -> Vec<Restricted> {
    payload["secretHosts"]
        .as_object()
        .into_iter()
        .flatten()
        .filter_map(|(name, hosts)| {
            let patterns: Vec<&str> = hosts.as_array()?.iter().filter_map(Value::as_str).collect();
            Some(Restricted {
                name: name.clone(),
                value: payload["resolvedSecrets"][name]
                    .as_str()
                    .unwrap_or_default()
                    .to_string(),
                hosts: AllowedHosts::stored(&patterns),
            })
        })
        .collect()
}

/// The error of a secret that would leave for a host it is not allowed on. It names the
/// secret, never its value.
pub fn denied(name: &str, host: &str) -> Error {
    Error::Validation(format!("Secret {name} cannot be sent to {host}"))
}

fn references(value: &Value, name: &str) -> bool {
    nexo_application::vault_references(value)
        .iter()
        .any(|reference| reference == name)
}

/// Where a restricted secret goes in a request.
#[derive(Clone, Debug)]
pub struct Placement {
    pub name: String,
    pub hosts: AllowedHosts,
    pub auth: bool,
    pub body: bool,
    /// Lowercase names of the headers that carry it.
    pub headers: Vec<String>,
}

/// The restricted secrets a collection-format request (`url`, `header`, `body`, `auth`)
/// carries, before the host fills its secrets.
pub fn placements(restricted: &[Restricted], request: &Value) -> Vec<Placement> {
    let method = request["method"]
        .as_str()
        .unwrap_or("GET")
        .to_ascii_uppercase();
    let sends_body = method != "GET" && method != "HEAD";
    let headers: Vec<(String, Value)> = match &request["header"] {
        Value::Array(rows) => rows
            .iter()
            .filter(|row| row["disabled"] != true && row["enabled"] != false)
            .map(|row| {
                (
                    row["key"].as_str().unwrap_or_default().to_ascii_lowercase(),
                    row.clone(),
                )
            })
            .collect(),
        Value::Object(map) => map
            .iter()
            .map(|(key, value)| {
                let mut row = Map::new();
                row.insert("key".into(), Value::String(key.clone()));
                row.insert("value".into(), value.clone());
                (key.to_ascii_lowercase(), Value::Object(row))
            })
            .collect(),
        _ => Vec::new(),
    };
    restricted
        .iter()
        .filter_map(|secret| {
            let placement = Placement {
                name: secret.name.clone(),
                hosts: secret.hosts.clone(),
                auth: references(&request["auth"], &secret.name),
                body: sends_body && references(&request["body"], &secret.name),
                headers: headers
                    .iter()
                    .filter(|(_, row)| references(row, &secret.name))
                    .map(|(name, _)| name.clone())
                    .collect(),
            };
            let anywhere = placement.auth
                || placement.body
                || !placement.headers.is_empty()
                || references(&request["url"], &secret.name);
            anywhere.then_some(placement)
        })
        .collect()
}

/// What one hop of a request sends, to decide which secrets travel with it.
pub struct Hop<'a> {
    pub host: &'a str,
    /// The request's own origin: everything is sent.
    pub same_origin: bool,
    pub body: bool,
    pub credential_headers: &'a [String],
    pub trust_redirect_credentials: bool,
}

/// Fails when a restricted secret would travel with this hop to a host it does not allow.
pub fn check_hop(placements: &[Placement], hop: &Hop) -> Result<()> {
    let credential = |name: &str| {
        hop.credential_headers
            .iter()
            .any(|credential| credential.eq_ignore_ascii_case(name))
    };
    for placement in placements {
        let travels = hop.same_origin
            || (placement.body && hop.body)
            // Authorizations write headers, which are credentials, or a form body.
            || (placement.auth && (hop.trust_redirect_credentials || hop.body))
            || placement
                .headers
                .iter()
                .any(|name| hop.trust_redirect_credentials || !credential(name));
        if travels && !placement.hosts.allows(hop.host) {
            return Err(denied(&placement.name, hop.host));
        }
    }
    Ok(())
}

/// The restricted secrets an OAuth 2.0 authorization's settings reference, before their
/// variables are replaced, except its access token.
pub fn referenced_by(restricted: &[Restricted], settings: &Value) -> Vec<Restricted> {
    let mut values = crate::auth::values(settings);
    // Also without the rows they were read from, which still hold the access token.
    if let Some(kind) = settings["type"].as_str() {
        values.remove(kind);
    }
    values.remove("accessToken");
    let settings = Value::Object(values);
    restricted
        .iter()
        .filter(|secret| !secret.value.is_empty() && references(&settings, &secret.name))
        .cloned()
        .collect()
}

/// Fails when a token request carries a restricted secret to a host it does not allow.
pub fn check_token_request(restricted: &[Restricted], request: &TokenRequest) -> Result<()> {
    let host = request.url.host_str().unwrap_or_default();
    let mut sent: Vec<String> = request
        .form
        .iter()
        .map(|(_, value)| value.clone())
        .collect();
    for (_, value) in &request.headers {
        sent.push(value.clone());
        if let Some(encoded) = value.strip_prefix("Basic ")
            && let Ok(decoded) = STANDARD.decode(encoded.trim())
        {
            sent.push(String::from_utf8_lossy(&decoded).into_owned());
        }
    }
    check_values(restricted, host, &sent)
}

/// Fails when an address the browser opens carries a restricted secret to a host it does
/// not allow.
pub fn check_address(restricted: &[Restricted], url: &Url) -> Result<()> {
    let mut sent: Vec<String> = url
        .query_pairs()
        .map(|(_, value)| value.into_owned())
        .collect();
    sent.push(url.as_str().to_string());
    check_values(restricted, url.host_str().unwrap_or_default(), &sent)
}

fn check_values(restricted: &[Restricted], host: &str, sent: &[String]) -> Result<()> {
    for secret in restricted {
        if !secret.value.is_empty()
            && sent.iter().any(|value| value.contains(&secret.value))
            && !secret.hosts.allows(host)
        {
            return Err(denied(&secret.name, host));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
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
        let address =
            Url::parse("https://login.test/authorize?client_id=app&x=client-s3cret").unwrap();
        assert!(check_address(&referenced, &address).is_err());
        let address = Url::parse("https://login.test/authorize?client_id=app").unwrap();
        assert!(check_address(&referenced, &address).is_ok());
    }
}
