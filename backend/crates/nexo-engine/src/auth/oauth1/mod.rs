//! OAuth 1.0 (RFC 5849), as postman-runtime `oauth1.js` with Postman's `node-oauth1`:
//! - signature base string: `METHOD&url&parameters`, with the URL normalized (lower-case
//!   scheme and host, no default port, no query) and the parameters (query, `oauth_*` and an
//!   `x-www-form-urlencoded` body) percent-encoded (RFC 3986) and sorted;
//! - HMAC-SHA1/SHA256/SHA512 with `consumerSecret&tokenSecret`, RSA-SHA1/SHA256/SHA512 with
//!   `privateKey`, or PLAINTEXT;
//! - nonce (11 characters) and timestamp generated when blank; empty parameters left out
//!   unless `addEmptyParamsToSign`; `oauth_body_hash` with `includeBodyHash`;
//! - added to the `Authorization: OAuth …` header (`addParamsToHeader`), else to a POST/PUT
//!   form body, else to the query.
//!
//! Bruno's and Insomnia's names are accepted too (`accessToken`/`tokenKey`, `callbackUrl`,
//! `placement`).

mod signing;

use super::{Outgoing, first, flag, percent_encode, text};
use aws_lc_rs::{digest, hmac, rand::SystemRandom, signature};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use nexo_domain::{Error, Result};
use rustls_pki_types::{PrivateKeyDer, pem::PemObject};
use serde_json::{Map, Value};
pub use signing::{base_string, signature};

const OAUTH_PARAMS: [&str; 10] = [
    "oauth_consumer_key",
    "oauth_token",
    "oauth_signature_method",
    "oauth_timestamp",
    "oauth_nonce",
    "oauth_version",
    "oauth_signature",
    "oauth_callback",
    "oauth_verifier",
    "oauth_body_hash",
];

fn invalid(message: impl Into<String>) -> Error {
    Error::Validation(message.into())
}

fn decode_form(text: &str) -> Vec<(String, String)> {
    url::form_urlencoded::parse(text.as_bytes())
        .map(|(k, v)| (k.into_owned(), v.into_owned()))
        .collect()
}

fn nonce() -> String {
    const CHARS: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    crate::vault::rand_bytes::<11>()
        .iter()
        .map(|b| CHARS[*b as usize % CHARS.len()] as char)
        .collect()
}

fn body_hash(method: &str, body: &[u8]) -> Option<String> {
    let algorithm = match method.split('-').nth(1)? {
        "SHA1" => &digest::SHA1_FOR_LEGACY_USE_ONLY,
        "SHA256" => &digest::SHA256,
        "SHA512" => &digest::SHA512,
        _ => return None,
    };
    Some(STANDARD.encode(digest::digest(algorithm, body)))
}

pub fn sign(auth: &Map<String, Value>, request: &mut Outgoing) -> Result<()> {
    let method = match first(auth, &["signatureMethod"]) {
        m if m.is_empty() => "HMAC-SHA1".to_string(),
        m => m.to_uppercase(),
    };
    let rsa = method.starts_with("RSA");
    let consumer_key = first(auth, &["consumerKey"]);
    let consumer_secret = first(auth, &["consumerSecret"]);
    let private_key = first(auth, &["privateKey"]);
    if consumer_key.is_empty()
        || (!rsa && consumer_secret.is_empty())
        || (rsa && private_key.is_empty())
    {
        return Ok(());
    }
    // Bruno can keep the key in a file next to its collection; Nexo collections have no folder
    // to resolve that path against, so the key text has to be pasted instead.
    if rsa && text(auth.get("privateKeyType")) == "file" {
        return Err(invalid(
            "OAuth 1.0: paste the private key text; key files from Bruno are not read",
        ));
    }
    let token = first(auth, &["token", "accessToken", "tokenKey"]);
    let token_secret = first(auth, &["tokenSecret", "accessTokenSecret"]);
    let callback = first(auth, &["callback", "callbackUrl"]);
    let verifier = first(auth, &["verifier"]);
    let realm = first(auth, &["realm"]);
    let version = text(auth.get("version"));
    let add_empty = flag(auth, "addEmptyParamsToSign");
    let placement = text(auth.get("placement"));
    let to_header = flag(auth, "addParamsToHeader") || placement == "header";
    let to_body = placement == "body";
    let urlencoded = request.headers.get("content-type").iter().any(|value| {
        value
            .to_lowercase()
            .contains("application/x-www-form-urlencoded")
    });

    // Earlier credentials are replaced.
    request.headers.delete("authorization");
    let query: Vec<(String, String)> = request
        .url
        .query()
        .map(decode_form)
        .unwrap_or_default()
        .into_iter()
        .filter(|(key, _)| !OAUTH_PARAMS.contains(&key.as_str()))
        .collect();
    set_query(request.url, &query);
    let mut body_params = Vec::new();
    if urlencoded {
        body_params = decode_form(&String::from_utf8_lossy(request.body))
            .into_iter()
            .filter(|(key, _)| !OAUTH_PARAMS.contains(&key.as_str()))
            .collect();
        *request.body = encode_pairs(&body_params).into_bytes();
    }

    let timestamp = match text(auth.get("timestamp")) {
        t if t.trim().is_empty() => std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs().to_string())
            .unwrap_or_default(),
        t => t,
    };
    let nonce = match text(auth.get("nonce")) {
        n if n.trim().is_empty() => nonce(),
        n => n,
    };
    let body_hash = (!urlencoded && flag(auth, "includeBodyHash"))
        .then(|| body_hash(&method, request.body))
        .flatten();
    let mut parameters: Vec<(String, String)> = [
        ("oauth_consumer_key", consumer_key),
        ("oauth_token", token),
        ("oauth_signature_method", method.clone()),
        ("oauth_timestamp", timestamp),
        ("oauth_nonce", nonce),
        ("oauth_version", version),
    ]
    .into_iter()
    .map(|(k, v)| (k.to_string(), v))
    .collect();
    // Extensions of the original specification go in only when set (Postman issue 8737).
    for (key, value) in [
        ("oauth_body_hash", body_hash.unwrap_or_default()),
        ("oauth_callback", callback),
        ("oauth_verifier", verifier),
    ] {
        if !value.is_empty() {
            parameters.push((key.into(), value));
        }
    }
    parameters.retain(|(_, value)| add_empty || !value.trim().is_empty());

    let mut signed = parameters.clone();
    signed.extend(body_params.iter().cloned());
    let base = base_string(request.method, request.url, &signed);
    let signature = signature(
        &method,
        &base,
        &consumer_secret,
        &token_secret,
        &private_key,
    )?;
    parameters.push(("oauth_signature".into(), signature));

    let post_form = urlencoded && matches!(request.method, "POST" | "PUT");
    if to_header {
        let disable_encoding = flag(auth, "disableHeaderEncoding");
        let encode = |value: &str| {
            if disable_encoding {
                value.to_string()
            } else {
                percent_encode(value)
            }
        };
        let mut fields = Vec::new();
        if !realm.trim().is_empty() {
            fields.push(format!("realm=\"{}\"", encode(&realm)));
        }
        for (key, value) in &parameters {
            if !value.is_empty() {
                fields.push(format!("{}=\"{}\"", encode(key), encode(value.trim())));
            }
        }
        request
            .headers
            .set("authorization", &format!("OAuth {}", fields.join(",")));
        request.credential_headers.push("authorization".into());
    } else if post_form || (to_body && urlencoded) {
        body_params.extend(parameters);
        *request.body = encode_pairs(&body_params).into_bytes();
    } else {
        let mut query = query;
        query.extend(parameters);
        set_query(request.url, &query);
    }
    Ok(())
}

fn encode_pairs(pairs: &[(String, String)]) -> String {
    pairs
        .iter()
        .map(|(key, value)| format!("{}={}", percent_encode(key), percent_encode(value)))
        .collect::<Vec<_>>()
        .join("&")
}

/// Rewrites the query with RFC 3986 encoding, as OAuth 1.0 requires.
fn set_query(url: &mut url::Url, pairs: &[(String, String)]) {
    if pairs.is_empty() {
        url.set_query(None);
    } else {
        url.set_query(Some(&encode_pairs(pairs)));
    }
}

#[cfg(test)]
mod tests;
