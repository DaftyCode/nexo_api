//! Hawk, as Postman signs it: postman-runtime `hawk.js` with the Hawk client of
//! postman-request. Insomnia names the keys `id`, `key`, `ext` and `validatePayload`.
//!
//! One difference: `ext` is escaped as the Hawk specification and servers do (every `\` and
//! newline), where postman-request escapes only the first of each.
use std::time::{SystemTime, UNIX_EPOCH};

use aws_lc_rs::{digest, hmac};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use nexo_domain::{Error, Result};
use serde_json::{Map, Value};

use super::{Outgoing, first, flag};

/// The request details a Hawk MAC covers.
struct Artifacts<'a> {
    timestamp: &'a str,
    nonce: &'a str,
    method: &'a str,
    resource: &'a str,
    host: &'a str,
    port: u16,
    hash: &'a str,
    ext: &'a str,
    app: &'a str,
    dlg: &'a str,
}

fn algorithms(name: &str) -> Result<(hmac::Algorithm, &'static digest::Algorithm)> {
    match name.to_ascii_lowercase().as_str() {
        "" | "sha256" => Ok((hmac::HMAC_SHA256, &digest::SHA256)),
        "sha1" => Ok((
            hmac::HMAC_SHA1_FOR_LEGACY_USE_ONLY,
            &digest::SHA1_FOR_LEGACY_USE_ONLY,
        )),
        other => Err(Error::Validation(format!(
            "Hawk: the algorithm must be sha256 or sha1, not {other}"
        ))),
    }
}

/// `hawk.1.payload`: the hash of the body and its media type.
fn payload_hash(algorithm: &'static digest::Algorithm, content_type: &str, body: &[u8]) -> String {
    let media_type = content_type
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    let mut context = digest::Context::new(algorithm);
    context.update(format!("hawk.1.payload\n{media_type}\n").as_bytes());
    context.update(body);
    context.update(b"\n");
    STANDARD.encode(context.finish())
}

/// `hawk.1.header`: the normalized request string, signed with the key.
fn mac(algorithm: hmac::Algorithm, key: &str, artifacts: &Artifacts) -> String {
    let ext = artifacts.ext.replace('\\', "\\\\").replace('\n', "\\n");
    let mut normalized = format!(
        "hawk.1.header\n{}\n{}\n{}\n{}\n{}\n{}\n{}\n{ext}\n",
        artifacts.timestamp,
        artifacts.nonce,
        artifacts.method.to_uppercase(),
        artifacts.resource,
        artifacts.host.to_lowercase(),
        artifacts.port,
        artifacts.hash,
    );
    if !artifacts.app.is_empty() {
        normalized.push_str(&format!("{}\n{}\n", artifacts.app, artifacts.dlg));
    }
    STANDARD.encode(hmac::sign(
        &hmac::Key::new(algorithm, key.as_bytes()),
        normalized.as_bytes(),
    ))
}

fn header(id: &str, artifacts: &Artifacts, mac: &str) -> String {
    let mut header = format!(
        "Hawk id=\"{id}\", ts=\"{}\", nonce=\"{}\"",
        artifacts.timestamp, artifacts.nonce
    );
    if !artifacts.hash.is_empty() {
        header.push_str(&format!(", hash=\"{}\"", artifacts.hash));
    }
    if !artifacts.ext.is_empty() {
        let ext = artifacts.ext.replace('\\', "\\\\").replace('"', "\\\"");
        header.push_str(&format!(", ext=\"{ext}\""));
    }
    header.push_str(&format!(", mac=\"{mac}\""));
    if !artifacts.app.is_empty() {
        header.push_str(&format!(", app=\"{}\"", artifacts.app));
        if !artifacts.dlg.is_empty() {
            header.push_str(&format!(", dlg=\"{}\"", artifacts.dlg));
        }
    }
    header
}

/// Six random letters and digits, as Postman generates the nonce.
fn nonce() -> String {
    const CHARS: &[u8] = b"abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    crate::vault::rand_bytes::<6>()
        .iter()
        .map(|b| CHARS[*b as usize % CHARS.len()] as char)
        .collect()
}

pub fn sign(auth: &Map<String, Value>, request: &mut Outgoing) -> Result<()> {
    let id = first(auth, &["authId", "id"]);
    let key = first(auth, &["authKey", "key"]);
    if id.is_empty() || key.is_empty() {
        return Ok(());
    }
    let (mac_algorithm, hash_algorithm) = algorithms(&first(auth, &["algorithm"]))?;
    request.headers.delete("Authorization");

    let nonce = match first(auth, &["nonce"]) {
        blank if blank.is_empty() => nonce(),
        nonce => nonce,
    };
    // Postman keeps a timestamp that is a number and uses the current time otherwise.
    let timestamp = first(auth, &["timestamp"])
        .trim()
        .parse::<u64>()
        .ok()
        .filter(|seconds| *seconds > 0)
        .unwrap_or_else(|| {
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|elapsed| elapsed.as_secs())
                .unwrap_or_default()
        })
        .to_string();
    // The body hash is optional and sent only when asked and there is a body.
    let hash = if (flag(auth, "includePayloadHash") || flag(auth, "validatePayload"))
        && !request.body.is_empty()
    {
        let content_type = request
            .headers
            .get("content-type")
            .first()
            .copied()
            .unwrap_or("")
            .to_string();
        payload_hash(hash_algorithm, &content_type, request.body)
    } else {
        String::new()
    };
    let resource = match request.url.query() {
        Some(query) if !query.is_empty() => format!("{}?{query}", request.url.path()),
        _ => request.url.path().to_string(),
    };
    let host = request
        .url
        .host_str()
        .unwrap_or("")
        .trim_start_matches('[')
        .trim_end_matches(']')
        .to_string();
    let port = request.url.port_or_known_default().unwrap_or(443);
    let ext = first(auth, &["extraData", "ext"]);
    let app = first(auth, &["app"]);
    let dlg = first(auth, &["delegation", "dlg"]);
    let artifacts = Artifacts {
        timestamp: &timestamp,
        nonce: &nonce,
        method: request.method,
        resource: &resource,
        host: &host,
        port,
        hash: &hash,
        ext: &ext,
        app: &app,
        dlg: &dlg,
    };
    let mac = mac(mac_algorithm, &key, &artifacts);
    request
        .headers
        .set("Authorization", &header(&id, &artifacts, &mac));
    request.credential_headers.push("Authorization".into());
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{auth::values, transport::HeaderList};
    use serde_json::json;

    const KEY: &str = "werxhqb98rpaxn39848xrunpaw3489ruxnpa98w4rxn";

    /// The example of the Hawk specification (README of hueniverse/hawk).
    fn example(method: &str, extra: &[(&str, Value)], body: &[u8]) -> String {
        let mut rows = vec![
            json!({"key": "authId", "value": "dh37fgj492je"}),
            json!({"key": "authKey", "value": KEY}),
            json!({"key": "algorithm", "value": "sha256"}),
            json!({"key": "timestamp", "value": "1353832234"}),
            json!({"key": "nonce", "value": "j4h3g2"}),
            json!({"key": "extraData", "value": "some-app-ext-data"}),
        ];
        for (key, value) in extra {
            rows.push(json!({"key": key, "value": value}));
        }
        let mut url = url::Url::parse("http://example.com:8000/resource/1?b=1&a=2").unwrap();
        let mut headers = HeaderList::default();
        headers.set("Authorization", "Basic old");
        headers.set("Content-Type", "text/plain; charset=utf-8");
        sign(
            &values(&json!({"type": "hawk", "hawk": rows})),
            &mut Outgoing {
                method,
                url: &mut url,
                headers: &mut headers,
                body: &mut body.to_vec(),
                credential_headers: &mut Vec::new(),
            },
        )
        .unwrap();
        headers.get("authorization")[0].to_string()
    }

    #[test]
    fn matches_the_specification_examples() {
        assert_eq!(
            example("GET", &[], b""),
            "Hawk id=\"dh37fgj492je\", ts=\"1353832234\", nonce=\"j4h3g2\", ext=\"some-app-ext-data\", mac=\"6R4rV5iE+NPoym+WwjeHzjAGXUtLNIxmo1vpMofpLAE=\""
        );
        assert_eq!(
            example(
                "POST",
                &[("includePayloadHash", json!(true))],
                b"Thank you for flying Hawk"
            ),
            "Hawk id=\"dh37fgj492je\", ts=\"1353832234\", nonce=\"j4h3g2\", hash=\"Yi9LfIIFRtBEPt74PVmbTF/xVAwPn7ub15ePICfgnuY=\", ext=\"some-app-ext-data\", mac=\"aSe1DERmZuRl3pI36/9BdZmnErTw3sNzOOAUlfeKjVw=\""
        );
        // Without the option, the body is not hashed.
        assert!(!example("POST", &[], b"Thank you for flying Hawk").contains("hash="));
    }

    #[test]
    fn adds_app_and_delegation_and_generates_nonce_and_timestamp() {
        let header = example(
            "GET",
            &[
                ("app", json!("my-app")),
                ("delegation", json!("their-app")),
                ("nonce", json!("")),
                ("timestamp", json!("not a number")),
            ],
            b"",
        );
        assert!(
            header.ends_with(", app=\"my-app\", dlg=\"their-app\""),
            "{header}"
        );
        let fields: Vec<&str> = header.split("\"").collect();
        assert_eq!(fields[5].len(), 6, "nonce: {header}");
        assert!(fields[3].parse::<u64>().unwrap() > 1_700_000_000);
    }

    #[test]
    fn reads_insomnia_keys_and_rejects_unknown_algorithms() {
        let (_, headers) = super::super::tests::signed(
            json!({"type": "hawk", "hawk": [
                {"key": "id", "value": "insomnia-id"}, {"key": "key", "value": KEY},
                {"key": "algorithm", "value": "sha1"}, {"key": "ext", "value": "a\"b\\c"},
            ]}),
            "https://[::1]/x",
        );
        let header = headers.get("authorization")[0];
        assert!(header.starts_with("Hawk id=\"insomnia-id\""), "{header}");
        assert!(header.contains("ext=\"a\\\"b\\\\c\""), "{header}");

        let mut url = url::Url::parse("https://example.com").unwrap();
        let error = sign(
            &values(&json!({"type": "hawk", "hawk": [
                {"key": "authId", "value": "i"}, {"key": "authKey", "value": "k"},
                {"key": "algorithm", "value": "md5"},
            ]})),
            &mut Outgoing {
                method: "GET",
                url: &mut url,
                headers: &mut HeaderList::default(),
                body: &mut Vec::new(),
                credential_headers: &mut Vec::new(),
            },
        )
        .unwrap_err();
        assert!(error.to_string().contains("sha256 or sha1"));
    }
}
