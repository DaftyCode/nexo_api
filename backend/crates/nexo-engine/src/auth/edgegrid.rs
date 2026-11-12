//! Akamai EdgeGrid (`EG1-HMAC-SHA256`), as Postman signs it (postman-runtime `edgegrid.js`).
//! Bruno uses the same keys: `accessToken`, `clientToken`, `clientSecret`, `nonce`,
//! `timestamp`, `baseURL`, `headersToSign` and `maxBodySize`.
//!
//! The signing key is the HMAC-SHA256 of the timestamp with the client secret; the signature
//! covers the method, scheme, host (from the base URL when set), path and query, the headers to
//! sign, the hash of a POST body (up to `maxBodySize` bytes, 128 KiB by default) and the
//! authorization header itself.
use aws_lc_rs::{digest, hmac};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use nexo_domain::Result;
use serde_json::{Map, Value};

use super::{Outgoing, text};

const DEFAULT_MAX_BODY: usize = 131_072;

fn base64_hmac(key: &str, data: &str) -> String {
    STANDARD.encode(hmac::sign(
        &hmac::Key::new(hmac::HMAC_SHA256, key.as_bytes()),
        data.as_bytes(),
    ))
}

/// `YYYYMMDDTHH:MM:SS+0000`, the UTC time as Postman writes it.
fn timestamp() -> String {
    let seconds = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_secs())
        .unwrap_or_default();
    // The SigV4 date (`YYYYMMDDTHHMMSSZ`) with colons and the offset.
    let compact = super::awsv4::amz_date(seconds);
    format!(
        "{}:{}:{}+0000",
        &compact[..11],
        &compact[11..13],
        &compact[13..15]
    )
}

/// The headers to sign as `name:value`, in the order given; blank or missing ones are left out.
fn canonical_headers(names: &[String], request: &Outgoing) -> String {
    names
        .iter()
        .filter_map(|name| {
            let name = name.trim().to_lowercase();
            let values = request.headers.get(&name);
            // Postman reads one value per name; repeated headers are not signed.
            let [value] = values[..] else { return None };
            if value.is_empty() {
                return None;
            }
            let value = value.split_whitespace().collect::<Vec<_>>().join(" ");
            Some(format!("{name}:{value}"))
        })
        .collect::<Vec<_>>()
        .join("\t")
}

fn headers_to_sign(value: Option<&Value>) -> Vec<String> {
    match value {
        Some(Value::String(text)) => text.split(',').map(str::to_string).collect(),
        Some(Value::Array(names)) => names
            .iter()
            .filter_map(|name| name.as_str().map(str::to_string))
            .collect(),
        _ => Vec::new(),
    }
}

/// The host to sign: the base URL's when set (Postman reads it like a URL, adding `http://`).
fn base_host(base_url: &str) -> Option<String> {
    let base_url = base_url.trim();
    if base_url.is_empty() {
        return None;
    }
    let with_scheme = if base_url.contains("://") {
        base_url.to_string()
    } else {
        format!("http://{base_url}")
    };
    let url = url::Url::parse(&with_scheme).ok()?;
    let host = url.host_str()?.to_string();
    Some(match url.port() {
        Some(port) => format!("{host}:{port}"),
        None => host,
    })
}

pub fn sign(auth: &Map<String, Value>, request: &mut Outgoing) -> Result<()> {
    let access_token = text(auth.get("accessToken"));
    let client_token = text(auth.get("clientToken"));
    let client_secret = text(auth.get("clientSecret"));
    if access_token.is_empty() || client_token.is_empty() || client_secret.is_empty() {
        return Ok(());
    }
    request.headers.delete("Authorization");
    let nonce = match text(auth.get("nonce")) {
        blank if blank.is_empty() => uuid::Uuid::new_v4().to_string(),
        nonce => nonce,
    };
    let timestamp = match text(auth.get("timestamp")) {
        blank if blank.is_empty() => timestamp(),
        timestamp => timestamp,
    };
    let max_body = match text(auth.get("maxBodySize")).trim() {
        "" => DEFAULT_MAX_BODY as i64,
        size => size.parse::<i64>().unwrap_or(DEFAULT_MAX_BODY as i64),
    };
    let header = format!(
        "EG1-HMAC-SHA256 client_token={client_token};access_token={access_token};timestamp={timestamp};nonce={nonce};"
    );
    let host = base_host(&text(auth.get("baseURL"))).unwrap_or_else(|| {
        let host = request.url.host_str().unwrap_or("").to_string();
        match request.url.port() {
            Some(port) => format!("{host}:{port}"),
            None => host,
        }
    });
    let path = match request.url.query() {
        Some(query) => format!("{}?{query}", request.url.path()),
        None => request.url.path().to_string(),
    };
    // Only POST bodies are hashed, as the specification says.
    let body_hash = if request.method == "POST" && !request.body.is_empty() {
        let limit = usize::try_from(max_body.max(0)).unwrap_or(0);
        let signed = &request.body[..request.body.len().min(limit)];
        STANDARD.encode(digest::digest(&digest::SHA256, signed))
    } else {
        String::new()
    };
    let data = [
        request.method.to_string(),
        request.url.scheme().to_string(),
        host,
        if path.is_empty() { "/".into() } else { path },
        canonical_headers(&headers_to_sign(auth.get("headersToSign")), request),
        body_hash,
        header.clone(),
    ]
    .join("\t");
    let signing_key = base64_hmac(&client_secret, &timestamp);
    let signature = base64_hmac(&signing_key, &data);
    request
        .headers
        .set("Authorization", &format!("{header}signature={signature}"));
    request.credential_headers.push("Authorization".into());
    Ok(())
}

#[cfg(test)]
mod tests;
