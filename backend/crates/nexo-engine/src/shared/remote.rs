//! A shared collection at the URL of a server that reads with `GET` and writes with `PUT`
//! (WebDAV: Nextcloud, ownCloud, a NAS, IIS…). Read only when asked, never on a schedule, and
//! conditionally: when the server says the version Nexo knows did not change (`304`), nothing
//! comes down. Written with `If-Match`, so that a teammate's change is never written over
//! (`412`), or with `If-None-Match: *` when the file is new. Through the egress policy, TLS
//! with aws-lc-rs, no redirects; the credentials come from the vault, filled in by the
//! application.
use super::{decode, encode, version};
use crate::{
    egress::Policy,
    transport::{Options, Transport, parse_url, read_limited},
};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use nexo_domain::{Error, Result, shared};
use serde_json::{Value, json};
use std::{sync::Arc, time::Duration};
use url::Url;

/// How long a server may take to answer.
const TIMEOUT: Duration = Duration::from_secs(60);
/// Bytes of a shared collection read at most.
const MAX_FILE: usize = 64 << 20;

fn url(payload: &Value) -> Result<Url> {
    let text = payload["location"]["url"]
        .as_str()
        .unwrap_or_default()
        .trim();
    let url = parse_url(text)?;
    if !matches!(url.scheme(), "http" | "https") || !shared::is_shared_file(url.path()) {
        return Err(Error::Validation(format!(
            "A shared collection on a server is an http or https URL ending in {}",
            shared::EXTENSION
        )));
    }
    Ok(url)
}

/// The authorization of the server: a user and password, or a token, from the vault.
fn headers(payload: &Value) -> Vec<(String, String)> {
    let auth = &payload["resolvedAuth"];
    let text = |name: &str| auth[name].as_str().unwrap_or_default();
    match text("scheme") {
        "basic" => {
            let pair = STANDARD.encode(format!("{}:{}", text("user"), text("password")));
            vec![("authorization".into(), format!("Basic {pair}"))]
        }
        "bearer" => vec![("authorization".into(), format!("Bearer {}", text("token")))],
        _ => Vec::new(),
    }
}

async fn transport(url: &Url, egress: &Policy, ports: &[u16]) -> Result<Transport> {
    let host = url.host_str().unwrap_or_default();
    let port = url.port_or_known_default().unwrap_or(443);
    egress.resolve(host, port, ports).await?;
    let options = Options {
        strict_ssl: true,
        follow_redirects: false,
        timeout: TIMEOUT,
        trust_redirect_credentials: false,
        transport: Value::Null,
        egress: egress.clone(),
        loopback_ports: ports.to_vec(),
        profiles: Value::Null,
        protection: None,
    };
    Transport::new(options, Arc::default())
}

/// What a refused call means to the person.
fn refused(status: u16) -> Error {
    match status {
        401 | 403 => {
            Error::Validation("The server refused the credentials of the shared collection".into())
        }
        _ => Error::Validation(format!(
            "The server of the shared collection answered HTTP {status}"
        )),
    }
}

fn etag(response: &reqwest::Response) -> Option<String> {
    response
        .headers()
        .get(reqwest::header::ETAG)
        .and_then(|value| value.to_str().ok())
        .map(String::from)
}

pub(super) async fn read(payload: &Value, egress: &Policy, ports: &[u16]) -> Result<Value> {
    let url = url(payload)?;
    let mut headers = headers(payload);
    let known = payload["known"].as_str().filter(|known| !known.is_empty());
    if let Some(known) = known {
        headers.push(("if-none-match".into(), known.into()));
    }
    let response = transport(&url, egress, ports)
        .await?
        .get(&url, &headers)
        .await?;
    let status = response.status().as_u16();
    match status {
        304 => return Ok(json!({"found": true, "unchanged": true, "version": known})),
        404 | 410 => return Ok(json!({"found": false})),
        200..=299 => {}
        other => return Err(refused(other)),
    }
    let tag = etag(&response);
    let text = read_limited(response, MAX_FILE).await?;
    let mut answer = decode(text.as_bytes(), payload)?;
    answer["version"] = json!(tag.unwrap_or_else(|| version(text.as_bytes())));
    Ok(answer)
}

pub(super) async fn write(payload: &Value, egress: &Policy, ports: &[u16]) -> Result<Value> {
    let url = url(payload)?;
    let file = encode(payload)?;
    let mut headers = headers(payload);
    headers.push(("content-type".into(), "application/json".into()));
    match payload["expected"].as_str() {
        Some(expected) => headers.push(("if-match".into(), expected.into())),
        None => headers.push(("if-none-match".into(), "*".into())),
    }
    let transport = transport(&url, egress, ports).await?;
    let response = transport.put(&url, &headers, file.clone()).await?;
    let status = response.status().as_u16();
    match status {
        412 => return Err(Error::Conflict),
        200..=299 => {}
        other => return Err(refused(other)),
    }
    // The version the server gives; one it does not give is that of what was written.
    let tag = etag(&response);
    Ok(json!({"version": tag.unwrap_or_else(|| version(&file))}))
}
