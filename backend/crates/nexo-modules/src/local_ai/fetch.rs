//! Large downloads of the local model: streamed to a file while their SHA-256 is computed,
//! only from the hosts of the catalog and through the egress policy, never more bytes than
//! the catalog says, and resumed where they stopped.
use crate::download::PolicyResolver;
use aws_lc_rs::digest::{Context, SHA256};
use nexo_application::ports::NetworkPolicy;
use nexo_domain::{Error, Result, hosts::AllowedHosts};
use reqwest::{Url, header, redirect};
use std::{path::Path, sync::Arc, time::Duration};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

/// How many redirections a download follows (GitHub and Hugging Face use one).
const REDIRECTS: usize = 5;

fn failed(reason: impl std::fmt::Display) -> Error {
    Error::Unavailable(format!("The local model could not be downloaded: {reason}"))
}

/// The client of the downloads: HTTPS (HTTP only for a test server), redirections only to
/// `hosts`, and no time limit for the whole file, only for each read.
pub(crate) fn client(
    network: Arc<dyn NetworkPolicy>,
    hosts: AllowedHosts,
    scheme: &str,
) -> Result<reqwest::Client> {
    let scheme = scheme.to_owned();
    let redirects = redirect::Policy::custom(move |attempt| {
        let allowed = attempt.url().scheme() == scheme
            && attempt
                .url()
                .host_str()
                .is_some_and(|host| hosts.allows(host));
        if attempt.previous().len() >= REDIRECTS {
            attempt.error("too many redirections")
        } else if allowed {
            attempt.follow()
        } else {
            let host = attempt.url().host_str().unwrap_or_default().to_owned();
            attempt.error(format!(
                "it was redirected to {host}, which Nexo does not download from"
            ))
        }
    });
    reqwest::Client::builder()
        .redirect(redirects)
        .dns_resolver(Arc::new(PolicyResolver(network)))
        .connect_timeout(Duration::from_secs(15))
        .read_timeout(Duration::from_secs(60))
        .user_agent(concat!("Nexo/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|error| Error::Infrastructure(error.to_string()))
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

/// Downloads `url` to `target`, which must have `size` bytes and the SHA-256 `sha256`.
/// `received` hears how many bytes of it are there. A `.part` file left by an earlier try is
/// continued when the server allows it.
pub(crate) async fn fetch(
    client: &reqwest::Client,
    url: &str,
    target: &Path,
    size: u64,
    sha256: &str,
    received: impl Fn(u64),
) -> Result<()> {
    let url = Url::parse(url).map_err(failed)?;
    let part = target.with_extension("part");
    let io = |error: std::io::Error| Error::Infrastructure(error.to_string());
    let mut hash = Context::new(&SHA256);
    let mut have = 0u64;
    if let Ok(mut file) = tokio::fs::File::open(&part).await {
        let mut buffer = vec![0u8; 1 << 20];
        loop {
            let read = file.read(&mut buffer).await.map_err(io)?;
            if read == 0 {
                break;
            }
            hash.update(&buffer[..read]);
            have += read as u64;
        }
    }
    if have > size {
        tokio::fs::remove_file(&part).await.map_err(io)?;
        (hash, have) = (Context::new(&SHA256), 0);
    }
    let mut request = client.get(url);
    if have > 0 {
        request = request.header(header::RANGE, format!("bytes={have}-"));
    }
    let mut response = request.send().await.map_err(|error| {
        let mut reason = error.to_string();
        let mut source = std::error::Error::source(&error);
        while let Some(cause) = source {
            reason = cause.to_string();
            source = cause.source();
        }
        failed(reason)
    })?;
    let status = response.status();
    if status.as_u16() == 200 && have > 0 {
        // The server sends the whole file again: start over.
        (hash, have) = (Context::new(&SHA256), 0);
    } else if !status.is_success() {
        return Err(failed(format!("the server answered {status}")));
    }
    let mut file = tokio::fs::OpenOptions::new()
        .create(true)
        .write(true)
        .append(have > 0)
        .truncate(have == 0)
        .open(&part)
        .await
        .map_err(io)?;
    received(have);
    while let Some(chunk) = response.chunk().await.map_err(failed)? {
        have += chunk.len() as u64;
        if have > size {
            drop(file);
            let _ = tokio::fs::remove_file(&part).await;
            return Err(Error::Validation(
                "The download is larger than Nexo expects; it was not installed".into(),
            ));
        }
        hash.update(&chunk);
        file.write_all(&chunk).await.map_err(io)?;
        received(have);
    }
    file.flush().await.map_err(io)?;
    drop(file);
    let found = hex(hash.finish().as_ref());
    if have != size || found != sha256 {
        let _ = tokio::fs::remove_file(&part).await;
        return Err(Error::Validation(format!(
            "The download does not match what Nexo expects (SHA-256 {found}); it was not installed"
        )));
    }
    tokio::fs::rename(&part, target).await.map_err(io)
}
