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
use aws_lc_rs::{digest, hmac, rand::SystemRandom, signature};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use nexo_domain::{Error, Result};
use rustls_pki_types::{PrivateKeyDer, pem::PemObject};
use serde_json::{Map, Value};

use super::{Outgoing, first, flag, percent_encode, text};

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

fn normalized_url(url: &url::Url) -> String {
    let host = url.host_str().unwrap_or("").to_lowercase();
    let authority = match url.port() {
        Some(port) => format!("{host}:{port}"),
        None => host,
    };
    let path = if url.path().is_empty() {
        "/"
    } else {
        url.path()
    };
    format!("{}://{authority}{path}", url.scheme().to_lowercase())
}

/// The signature base string (RFC 5849 section 3.4.1).
pub fn base_string(method: &str, url: &url::Url, parameters: &[(String, String)]) -> String {
    let mut all: Vec<(String, String)> = url.query().map(decode_form).unwrap_or_default();
    all.extend(parameters.iter().cloned());
    let mut sortable: Vec<(String, String)> = all
        .iter()
        .filter(|(key, _)| key != "oauth_signature")
        .map(|(key, value)| (percent_encode(key), percent_encode(value)))
        .collect();
    sortable.sort_by(|a, b| format!("{} {}", a.0, a.1).cmp(&format!("{} {}", b.0, b.1)));
    let normalized = sortable
        .iter()
        .map(|(key, value)| format!("{key}={value}"))
        .collect::<Vec<_>>()
        .join("&");
    format!(
        "{}&{}&{}",
        percent_encode(&method.to_uppercase()),
        percent_encode(&normalized_url(url)),
        percent_encode(&normalized)
    )
}

fn rsa_sign(private_key: &str, hash: &str, message: &[u8]) -> Result<Vec<u8>> {
    let key = PrivateKeyDer::from_pem_slice(private_key.as_bytes())
        .map_err(|_| invalid("The private key must be an RSA key in PEM format"))?;
    let der = key.secret_der();
    if hash == "SHA1" {
        return rsa_sha1(der, message);
    }
    let pair = match &key {
        PrivateKeyDer::Pkcs8(_) => signature::RsaKeyPair::from_pkcs8(der),
        _ => signature::RsaKeyPair::from_der(der),
    }
    .map_err(|_| invalid("The private key is not a valid RSA key"))?;
    let encoding: &'static dyn signature::RsaEncoding = match hash {
        "SHA256" => &signature::RSA_PKCS1_SHA256,
        "SHA512" => &signature::RSA_PKCS1_SHA512,
        other => return Err(invalid(format!("Unsupported RSA hash: {other}"))),
    };
    let mut output = vec![0; pair.public_modulus_len()];
    pair.sign(encoding, &SystemRandom::new(), message, &mut output)
        .map_err(|_| invalid("Could not sign with the RSA key"))?;
    Ok(output)
}

/// RSA PKCS#1 v1.5 with SHA-1, which aws-lc-rs only offers for verifying: signed with the
/// AWS-LC library underneath it.
fn rsa_sha1(der: &[u8], message: &[u8]) -> Result<Vec<u8>> {
    use aws_lc_sys as ffi;
    let failed = || invalid("Could not sign with the RSA key (RSA-SHA1)");
    let length = std::os::raw::c_long::try_from(der.len()).map_err(|_| failed())?;
    // SAFETY: every pointer comes from AWS-LC and is checked for null before use; the key
    // and context are freed on every path; `der` and `message` outlive the calls, and the
    // output buffer has the size AWS-LC reports.
    unsafe {
        let mut input = der.as_ptr();
        let key = ffi::d2i_AutoPrivateKey(std::ptr::null_mut(), &mut input, length);
        if key.is_null() {
            return Err(invalid("The private key is not a valid RSA key"));
        }
        let context = ffi::EVP_MD_CTX_new();
        let result = (|| {
            if context.is_null()
                || ffi::EVP_DigestSignInit(
                    context,
                    std::ptr::null_mut(),
                    ffi::EVP_sha1(),
                    std::ptr::null_mut(),
                    key,
                ) != 1
            {
                return Err(failed());
            }
            let mut size = 0usize;
            if ffi::EVP_DigestSign(
                context,
                std::ptr::null_mut(),
                &mut size,
                message.as_ptr(),
                message.len(),
            ) != 1
            {
                return Err(failed());
            }
            let mut output = vec![0u8; size];
            if ffi::EVP_DigestSign(
                context,
                output.as_mut_ptr(),
                &mut size,
                message.as_ptr(),
                message.len(),
            ) != 1
            {
                return Err(failed());
            }
            output.truncate(size);
            Ok(output)
        })();
        if !context.is_null() {
            ffi::EVP_MD_CTX_free(context);
        }
        ffi::EVP_PKEY_free(key);
        result
    }
}

/// The `oauth_signature` value for a base string.
pub fn signature(
    method: &str,
    base: &str,
    consumer_secret: &str,
    token_secret: &str,
    private_key: &str,
) -> Result<String> {
    let key = format!(
        "{}&{}",
        percent_encode(consumer_secret),
        percent_encode(token_secret)
    );
    let hmac = |algorithm| {
        STANDARD.encode(hmac::sign(
            &hmac::Key::new(algorithm, key.as_bytes()),
            base.as_bytes(),
        ))
    };
    Ok(match method {
        "PLAINTEXT" => key.clone(),
        "HMAC-SHA1" => hmac(hmac::HMAC_SHA1_FOR_LEGACY_USE_ONLY),
        "HMAC-SHA256" => hmac(hmac::HMAC_SHA256),
        "HMAC-SHA512" => hmac(hmac::HMAC_SHA512),
        "RSA-SHA1" | "RSA-SHA256" | "RSA-SHA512" => STANDARD.encode(rsa_sign(
            private_key,
            &method[4..].replace('-', ""),
            base.as_bytes(),
        )?),
        other => {
            return Err(invalid(format!(
                "Unsupported OAuth 1.0 signature method: {other}"
            )));
        }
    })
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
mod tests {
    use super::*;
    use crate::{auth::values, transport::HeaderList};
    use serde_json::json;

    #[test]
    fn builds_twitter_documented_base_string() {
        let (auth, url, _, body) = twitter(&[]);
        let mut parameters: Vec<(String, String)> = [
            ("oauth_consumer_key", "xvz1evFS4wEEPTGEFPHBog"),
            (
                "oauth_token",
                "370773112-GmHxMAgYyLbNEtIKZeRNFsMKPR9EyMZeS9weJAEb",
            ),
            ("oauth_signature_method", "HMAC-SHA1"),
            ("oauth_timestamp", "1318622958"),
            ("oauth_nonce", "kYjzVBB8Y0ZFabxSWbWovY3uYSQ2pTgmZeNu2VS4cg"),
            ("oauth_version", "1.0"),
        ]
        .iter()
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect();
        parameters.extend(decode_form(std::str::from_utf8(&body).unwrap()));
        assert!(auth.contains_key("consumerKey"));
        assert_eq!(
            base_string("POST", &url, &parameters),
            "POST&https%3A%2F%2Fapi.twitter.com%2F1.1%2Fstatuses%2Fupdate.json&include_entities%3Dtrue%26oauth_consumer_key%3Dxvz1evFS4wEEPTGEFPHBog%26oauth_nonce%3DkYjzVBB8Y0ZFabxSWbWovY3uYSQ2pTgmZeNu2VS4cg%26oauth_signature_method%3DHMAC-SHA1%26oauth_timestamp%3D1318622958%26oauth_token%3D370773112-GmHxMAgYyLbNEtIKZeRNFsMKPR9EyMZeS9weJAEb%26oauth_version%3D1.0%26status%3DHello%2520Ladies%2520%252B%2520Gentlemen%252C%2520a%2520signed%2520OAuth%2520request%2521"
        );
    }

    /// Twitter's documented example ("Creating a signature"): hCtSmYh+iHYCEqBWrE7C7hYmtUk=.
    fn twitter(extra: &[(&str, Value)]) -> (Map<String, Value>, url::Url, HeaderList, Vec<u8>) {
        let mut rows = vec![
            json!({"key": "consumerKey", "value": "xvz1evFS4wEEPTGEFPHBog"}),
            json!({"key": "consumerSecret", "value": "kAcSOqF21Fu85e7zjz7ZN2U4ZRhfV3WpwPAoE3Z7kBw"}),
            json!({"key": "token", "value": "370773112-GmHxMAgYyLbNEtIKZeRNFsMKPR9EyMZeS9weJAEb"}),
            json!({"key": "tokenSecret", "value": "LswwdoUaIvS8ltyTt5jkRh4J50vUPVVHtR2YPi5kE"}),
            json!({"key": "signatureMethod", "value": "HMAC-SHA1"}),
            json!({"key": "timestamp", "value": "1318622958"}),
            json!({"key": "nonce", "value": "kYjzVBB8Y0ZFabxSWbWovY3uYSQ2pTgmZeNu2VS4cg"}),
            json!({"key": "version", "value": "1.0"}),
        ];
        for (key, value) in extra {
            rows.push(json!({"key": key, "value": value}));
        }
        let mut headers = HeaderList::default();
        headers.set("content-type", "application/x-www-form-urlencoded");
        (
            values(&json!({"type": "oauth1", "oauth1": rows})),
            url::Url::parse(
                "https://api.twitter.com/1.1/statuses/update.json?include_entities=true",
            )
            .unwrap(),
            headers,
            b"status=Hello%20Ladies%20%2B%20Gentlemen%2C%20a%20signed%20OAuth%20request%21"
                .to_vec(),
        )
    }
    fn run(
        auth: &Map<String, Value>,
        url: &mut url::Url,
        headers: &mut HeaderList,
        body: &mut Vec<u8>,
    ) {
        sign(
            auth,
            &mut Outgoing {
                method: "POST",
                url,
                headers,
                body,
                credential_headers: &mut Vec::new(),
            },
        )
        .unwrap();
    }

    #[test]
    fn signs_the_twitter_example_in_the_header() {
        let (auth, mut url, mut headers, mut body) = twitter(&[("addParamsToHeader", json!(true))]);
        run(&auth, &mut url, &mut headers, &mut body);
        let header = headers.get("authorization")[0].to_string();
        assert!(
            header.starts_with("OAuth oauth_consumer_key=\"xvz1evFS4wEEPTGEFPHBog\","),
            "{header}"
        );
        assert!(
            header.contains("oauth_signature=\"hCtSmYh%2BiHYCEqBWrE7C7hYmtUk%3D\""),
            "{header}"
        );
        assert_eq!(url.query(), Some("include_entities=true"));
    }

    #[test]
    fn adds_the_parameters_to_a_form_body_or_to_the_query() {
        let (auth, mut url, mut headers, mut body) = twitter(&[]);
        run(&auth, &mut url, &mut headers, &mut body);
        let form = String::from_utf8(body).unwrap();
        assert!(form.starts_with("status=Hello%20Ladies"), "{form}");
        assert!(
            form.contains("oauth_signature=hCtSmYh%2BiHYCEqBWrE7C7hYmtUk%3D"),
            "{form}"
        );
        assert!(headers.get("authorization").is_empty());

        // Without a form body, the signature goes in the query.
        let (auth, mut url, mut headers, _) = twitter(&[]);
        headers.delete("content-type");
        run(&auth, &mut url, &mut headers, &mut Vec::new());
        let query = url.query().unwrap();
        assert!(
            query.starts_with("include_entities=true&oauth_consumer_key="),
            "{query}"
        );
        assert!(query.contains("oauth_signature="));
    }

    #[test]
    fn rsa_keys_must_be_pasted_not_bruno_files() {
        let (auth, mut url, mut headers, mut body) = twitter(&[
            ("signatureMethod", json!("RSA-SHA256")),
            ("privateKey", json!("keys/private.pem")),
            ("privateKeyType", json!("file")),
        ]);
        let error = sign(
            &auth,
            &mut Outgoing {
                method: "POST",
                url: &mut url,
                headers: &mut headers,
                body: &mut body,
                credential_headers: &mut Vec::new(),
            },
        )
        .unwrap_err();
        assert!(error.to_string().contains("paste the private key text"));
    }

    #[test]
    fn plaintext_realm_empty_parameters_and_body_hash() {
        let (auth, mut url, mut headers, _) = twitter(&[
            ("signatureMethod", json!("PLAINTEXT")),
            ("addParamsToHeader", json!(true)),
            ("realm", json!("Photos")),
            ("version", json!("")),
        ]);
        headers.delete("content-type");
        run(&auth, &mut url, &mut headers, &mut b"{}".to_vec());
        let header = headers.get("authorization")[0].to_string();
        assert!(header.starts_with("OAuth realm=\"Photos\","), "{header}");
        // PLAINTEXT is the encoded secrets joined by "&", encoded again in the header.
        assert!(header.contains(
            "oauth_signature=\"kAcSOqF21Fu85e7zjz7ZN2U4ZRhfV3WpwPAoE3Z7kBw%26LswwdoUaIvS8ltyTt5jkRh4J50vUPVVHtR2YPi5kE\""
        ));
        assert!(!header.contains("oauth_version"));

        let (auth, mut url, mut headers, _) = twitter(&[
            ("addParamsToHeader", json!(true)),
            ("includeBodyHash", json!(true)),
        ]);
        headers.delete("content-type");
        run(&auth, &mut url, &mut headers, &mut b"{}".to_vec());
        // Base64 SHA-1 of "{}".
        assert!(
            headers.get("authorization")[0]
                .contains("oauth_body_hash=\"vyGp6PvFo4RvsFtPoIWeCReyIC8%3D\"")
        );
    }

    #[test]
    fn percent_encodes_like_rfc_3986() {
        assert_eq!(percent_encode("a b+c*~!'()"), "a%20b%2Bc%2A~%21%27%28%29");
        assert_eq!(percent_encode("ñ"), "%C3%B1");
    }
}
