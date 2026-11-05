//! Digest Auth, as postman-runtime `digest.js` (RFC 7616 / RFC 2617):
//! - with `username` and a `realm` (typed in, or from an earlier challenge) the request is
//!   signed up front;
//! - otherwise, a `401`/`403` with a `WWW-Authenticate: Digest …` challenge is answered once
//!   (unless `disableRetryRequest`), choosing the challenge of the selected `algorithm`;
//! - algorithms MD5 (default), MD5-sess, SHA-256, SHA-256-sess, SHA-512-256 and its -sess;
//! - `qop` `auth` or `auth-int` (which also signs the body), with `nonceCount` and
//!   `clientNonce`; `opaque` is echoed back.
use md5::Md5;
use nexo_domain::{Error, Result};
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256, Sha512_256};

use super::{Outgoing, flag, text};

const ONE: &str = "00000001";

fn field(challenge: &str, name: &str) -> Option<String> {
    let lower = challenge.to_lowercase();
    let mut search = 0;
    while let Some(found) = lower[search..].find(name) {
        let start = search + found;
        let before = lower[..start].chars().last();
        let after = &challenge[start + name.len()..];
        if matches!(before, None | Some(' ' | ',')) && after.trim_start().starts_with('=') {
            let value = after.trim_start()[1..].trim_start();
            return Some(if let Some(quoted) = value.strip_prefix('"') {
                quoted[..quoted.find('"').unwrap_or(quoted.len())].to_string()
            } else {
                value[..value.find(',').unwrap_or(value.len())]
                    .trim()
                    .to_string()
            });
        }
        search = start + name.len();
    }
    None
}

/// The challenge to answer: the one of the selected algorithm, else the first Digest one.
/// A challenge without `algorithm` is an MD5 one.
pub fn choose<'a>(challenges: &'a [String], algorithm: &str) -> Option<&'a str> {
    let digest: Vec<&str> = challenges
        .iter()
        .map(String::as_str)
        .filter(|c| c.trim_start().to_lowercase().starts_with("digest"))
        .collect();
    let wanted = algorithm.to_lowercase();
    digest
        .iter()
        .find(|challenge| match field(challenge, "algorithm") {
            None => wanted.is_empty() || wanted == "md5",
            Some(offered) => !wanted.is_empty() && offered.to_lowercase() == wanted,
        })
        .or(digest.first())
        .copied()
}

fn random_nonce() -> String {
    const CHARS: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    crate::vault::rand_bytes::<8>()
        .iter()
        .map(|b| CHARS[*b as usize % CHARS.len()] as char)
        .collect()
}

/// Answers a challenge: records realm, nonce, qop and opaque, and signs the request.
pub fn answer(
    auth: &mut Map<String, Value>,
    status: u16,
    challenges: &[String],
    request: &mut Outgoing,
) -> Result<bool> {
    if flag(auth, "disableRetryRequest") || !(status == 401 || status == 403) {
        return Ok(false);
    }
    let Some(challenge) = choose(challenges, &text(auth.get("algorithm"))) else {
        return Ok(false);
    };
    let offered_algorithm = field(challenge, "algorithm");
    for (key, value) in [
        ("realm", field(challenge, "realm")),
        ("nonce", field(challenge, "nonce")),
        ("opaque", field(challenge, "opaque")),
    ] {
        if let Some(value) = value {
            auth.insert(key.into(), json!(value));
        }
    }
    if let Some(qop) = field(challenge, "qop") {
        let options: Vec<&str> = qop.split(',').map(str::trim).collect();
        let chosen = text(auth.get("qop"));
        let qop = if !chosen.is_empty() && options.contains(&chosen.as_str()) {
            chosen
        } else if options.contains(&"auth") {
            "auth".into()
        } else {
            options.first().copied().unwrap_or("auth").into()
        };
        auth.insert("qop".into(), json!(qop));
    }
    // Postman uses the selected algorithm; without one, the server's is used.
    if text(auth.get("algorithm")).is_empty()
        && let Some(algorithm) = offered_algorithm
    {
        auth.insert("algorithm".into(), json!(algorithm));
    }
    if !text(auth.get("qop")).is_empty() {
        auth.insert("clientNonce".into(), json!(random_nonce()));
        auth.insert("nonceCount".into(), json!(ONE));
    }
    sign(auth, request)?;
    Ok(true)
}

/// Signs with the realm and nonce known; does nothing without a username and a realm.
pub fn sign(auth: &Map<String, Value>, request: &mut Outgoing) -> Result<()> {
    let username = text(auth.get("username"));
    let realm = text(auth.get("realm"));
    if username.is_empty() || realm.is_empty() {
        return Ok(());
    }
    let header = header(auth, request.method, request.url, request.body)?;
    request.headers.set("authorization", &header);
    Ok(())
}

/// The `Authorization` header, with the fields in Postman's order.
pub fn header(
    auth: &Map<String, Value>,
    method: &str,
    url: &url::Url,
    body: &[u8],
) -> Result<String> {
    let username = text(auth.get("username"));
    let password = text(auth.get("password"));
    let realm = text(auth.get("realm"));
    let nonce = text(auth.get("nonce"));
    let qop = text(auth.get("qop"));
    let opaque = text(auth.get("opaque"));
    let algorithm = match text(auth.get("algorithm")) {
        a if a.is_empty() => "MD5".to_string(),
        a => a,
    };
    let hash = |value: &[u8]| -> Result<String> {
        Ok(match algorithm.to_uppercase().trim_end_matches("-SESS") {
            "MD5" => hex::encode(Md5::digest(value)),
            "SHA-256" => hex::encode(Sha256::digest(value)),
            "SHA-512-256" => hex::encode(Sha512_256::digest(value)),
            _ => {
                return Err(Error::Validation(format!(
                    "Unsupported digest algorithm: {algorithm}"
                )));
            }
        })
    };
    let session = algorithm.to_uppercase().ends_with("-SESS");
    let uses_qop = qop == "auth" || qop == "auth-int";
    let client_nonce = match text(auth.get("clientNonce")) {
        c if c.is_empty() && (uses_qop || session) => random_nonce(),
        c => c,
    };
    let nonce_count = match text(auth.get("nonceCount")) {
        n if n.is_empty() && uses_qop => ONE.to_string(),
        n => n,
    };
    let uri = match url.query() {
        Some(query) => format!("{}?{query}", url.path()),
        None => url.path().to_string(),
    };
    let a1 = if session {
        let a0 = hash(format!("{username}:{realm}:{password}").as_bytes())?;
        format!("{a0}:{nonce}:{client_nonce}")
    } else {
        format!("{username}:{realm}:{password}")
    };
    let a2 = if qop == "auth-int" {
        format!("{method}:{uri}:{}", hash(body)?)
    } else {
        format!("{method}:{uri}")
    };
    let (ha1, ha2) = (hash(a1.as_bytes())?, hash(a2.as_bytes())?);
    let response = if uses_qop {
        hash(format!("{ha1}:{nonce}:{nonce_count}:{client_nonce}:{qop}:{ha2}").as_bytes())?
    } else {
        hash(format!("{ha1}:{nonce}:{ha2}").as_bytes())?
    };
    // Quotes and backslashes inside quoted values are escaped (RFC 7230 quoted-string).
    let quote = |value: &str| value.replace('\\', "\\\\").replace('"', "\\\"");
    let mut fields = vec![
        format!("username=\"{}\"", quote(&username)),
        format!("realm=\"{}\"", quote(&realm)),
        format!("nonce=\"{}\"", quote(&nonce)),
        format!("uri=\"{uri}\""),
        format!("algorithm=\"{algorithm}\""),
    ];
    if uses_qop {
        fields.push(format!("qop={qop}"));
    }
    if uses_qop || algorithm.eq_ignore_ascii_case("MD5-sess") {
        if !nonce_count.is_empty() {
            fields.push(format!("nc={nonce_count}"));
        }
        fields.push(format!("cnonce=\"{client_nonce}\""));
    }
    fields.push(format!("response=\"{response}\""));
    if !opaque.is_empty() {
        fields.push(format!("opaque=\"{}\"", quote(&opaque)));
    }
    Ok(format!("Digest {}", fields.join(", ")))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn settings(entries: &[(&str, &str)]) -> Map<String, Value> {
        entries
            .iter()
            .map(|(k, v)| (k.to_string(), json!(v)))
            .collect()
    }
    fn get(url: &str) -> url::Url {
        url::Url::parse(url).unwrap()
    }

    #[test]
    fn matches_the_rfc_2617_example() {
        // RFC 2617 section 3.5: Mufasa / "Circle Of Life", qop=auth.
        let auth = settings(&[
            ("username", "Mufasa"),
            ("password", "Circle Of Life"),
            ("realm", "testrealm@host.com"),
            ("nonce", "dcd98b7102dd2f0e8b11d0f600bfb0c093"),
            ("qop", "auth"),
            ("nonceCount", "00000001"),
            ("clientNonce", "0a4f113b"),
            ("opaque", "5ccc069c403ebaf9f0171e9517f40e41"),
        ]);
        let header = header(
            &auth,
            "GET",
            &get("http://www.nowhere.org/dir/index.html"),
            b"",
        )
        .unwrap();
        assert_eq!(
            header,
            "Digest username=\"Mufasa\", realm=\"testrealm@host.com\", \
             nonce=\"dcd98b7102dd2f0e8b11d0f600bfb0c093\", uri=\"/dir/index.html\", \
             algorithm=\"MD5\", qop=auth, nc=00000001, cnonce=\"0a4f113b\", \
             response=\"6629fae49393a05397450978507c4ef1\", opaque=\"5ccc069c403ebaf9f0171e9517f40e41\""
        );
    }

    #[test]
    fn matches_the_rfc_2069_example_without_qop() {
        let auth = settings(&[
            ("username", "Mufasa"),
            ("password", "Circle Of Life"),
            ("realm", "testrealm@host.com"),
            ("nonce", "dcd98b7102dd2f0e8b11d0f600bfb0c093"),
        ]);
        let header = header(&auth, "GET", &get("http://x.test/dir/index.html"), b"").unwrap();
        assert!(
            header.contains("response=\"670fd8c2df070c60b045671b8b24ff02\""),
            "{header}"
        );
    }

    #[test]
    fn matches_the_rfc_7616_sha256_example() {
        // RFC 7616 section 3.9.1, SHA-256.
        let auth = settings(&[
            ("username", "Mufasa"),
            ("password", "Circle of Life"),
            ("realm", "http-auth@example.org"),
            ("nonce", "7ypf/xlj9XXwfDPEoM4URrv/xwf94BcCAzFZH4GiTo0v"),
            ("qop", "auth"),
            ("nonceCount", "00000001"),
            (
                "clientNonce",
                "f2/wE4q74E6zIJEtWaHKaf5wv/H5QzzpXusqGemxURZJ",
            ),
            ("algorithm", "SHA-256"),
        ]);
        let header = header(
            &auth,
            "GET",
            &get("http://www.example.org/dir/index.html"),
            b"",
        )
        .unwrap();
        assert!(
            header.contains(
                "response=\"753927fa0e85d155564e2e272a28d1802ca10daf4496794697cf8db5856cb6c1\""
            ),
            "{header}"
        );
    }

    #[test]
    fn auth_int_signs_the_body_and_sha_512_256_is_supported() {
        let mut auth = settings(&[
            ("username", "u"),
            ("password", "p"),
            ("realm", "r"),
            ("nonce", "n"),
            ("qop", "auth-int"),
            ("clientNonce", "c"),
            ("algorithm", "SHA-512-256-sess"),
        ]);
        let url = get("http://x.test/a?b=1");
        let one = header(&auth, "POST", &url, b"one").unwrap();
        let two = header(&auth, "POST", &url, b"two").unwrap();
        assert_ne!(one, two);
        assert!(one.contains("uri=\"/a?b=1\""));
        assert!(one.contains("qop=auth-int, nc=00000001, cnonce=\"c\""));
        auth.insert("algorithm".into(), json!("SHA-1"));
        assert!(header(&auth, "GET", &url, b"").is_err());
    }

    #[test]
    fn chooses_the_challenge_of_the_selected_algorithm() {
        let challenges = vec![
            "Basic realm=\"x\"".to_string(),
            "Digest realm=\"r\", nonce=\"md5\"".to_string(),
            "Digest realm=\"r\", nonce=\"sha\", algorithm=SHA-256".to_string(),
        ];
        assert!(choose(&challenges, "SHA-256").unwrap().contains("\"sha\""));
        assert!(choose(&challenges, "MD5").unwrap().contains("\"md5\""));
        assert!(choose(&challenges, "").unwrap().contains("\"md5\""));
        assert!(choose(&challenges[..1], "").is_none());
    }

    #[test]
    fn reads_quoted_and_bare_fields() {
        let challenge = "Digest realm=\"a, b\", qop=\"auth,auth-int\", nonce=xyz, stale=false";
        assert_eq!(field(challenge, "realm").as_deref(), Some("a, b"));
        assert_eq!(field(challenge, "qop").as_deref(), Some("auth,auth-int"));
        assert_eq!(field(challenge, "nonce").as_deref(), Some("xyz"));
        assert_eq!(field(challenge, "opaque"), None);
    }
}
