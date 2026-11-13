//! Downloading a release asset: only from the hosts of the releases, through the egress
//! policy, and never more bytes than the manifest says.
use crate::catalog::ModuleEntry;
use nexo_application::ports::NetworkPolicy;
use nexo_domain::{Error, Result, hosts::AllowedHosts};
use reqwest::{Url, redirect};
use std::{net::SocketAddr, sync::Arc, time::Duration};

/// How many redirections a download follows (GitHub uses one).
const REDIRECTS: usize = 5;

/// Whether a download may go to `url`: a host of the releases, with the scheme of the
/// source (HTTPS, except a test server).
pub(crate) fn allowed(url: &Url, hosts: &AllowedHosts, scheme: &str) -> bool {
    url.scheme() == scheme && url.host_str().is_some_and(|host| hosts.allows(host))
}

/// Resolves every host through the egress policy, so a download goes only where the policy
/// allows, whatever the DNS answers after a check.
struct PolicyResolver(Arc<dyn NetworkPolicy>);
impl reqwest::dns::Resolve for PolicyResolver {
    fn resolve(&self, name: reqwest::dns::Name) -> reqwest::dns::Resolving {
        let network = self.0.clone();
        let host = name.as_str().to_owned();
        Box::pin(async move {
            // The connector puts the port of the address it connects to.
            let addresses = network.resolve_destination(&host, 0).await.map_err(
                |error| -> Box<dyn std::error::Error + Send + Sync> { error.to_string().into() },
            )?;
            Ok(Box::new(addresses.into_iter()) as Box<dyn Iterator<Item = SocketAddr> + Send>)
        })
    }
}

/// The client of the downloads.
pub(crate) fn client(
    network: Arc<dyn NetworkPolicy>,
    hosts: AllowedHosts,
    scheme: String,
) -> Result<reqwest::Client> {
    let redirects = redirect::Policy::custom(move |attempt| {
        if attempt.previous().len() >= REDIRECTS {
            attempt.error("too many redirections")
        } else if allowed(attempt.url(), &hosts, &scheme) {
            attempt.follow()
        } else {
            let host = attempt.url().host_str().unwrap_or_default().to_owned();
            attempt.error(format!(
                "it was redirected to {host}, which is not where Nexo's releases are"
            ))
        }
    });
    reqwest::Client::builder()
        .redirect(redirects)
        .dns_resolver(Arc::new(PolicyResolver(network)))
        .connect_timeout(Duration::from_secs(15))
        // A module is a few megabytes; even a slow connection takes less than this.
        .timeout(Duration::from_secs(600))
        .user_agent(concat!("Nexo/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|error| Error::Infrastructure(error.to_string()))
}

fn download_failed(entry: &ModuleEntry, reason: impl std::fmt::Display) -> Error {
    Error::Unavailable(format!(
        "The {} module could not be downloaded: {reason}",
        entry.name
    ))
}

/// The release asset of a module, read whole. `received` hears how many bytes arrived.
pub(crate) async fn download(
    client: &reqwest::Client,
    url: Url,
    entry: &ModuleEntry,
    received: impl Fn(u64),
) -> Result<Vec<u8>> {
    let mut response = client.get(url).send().await.map_err(|error| {
        // The reason of a refused redirection or a blocked host is in the source error.
        let mut reason = error.to_string();
        let mut source = std::error::Error::source(&error);
        while let Some(cause) = source {
            reason = cause.to_string();
            source = cause.source();
        }
        download_failed(entry, reason)
    })?;
    if !response.status().is_success() {
        return Err(download_failed(
            entry,
            format!("the server answered {}", response.status()),
        ));
    }
    let mut content = Vec::with_capacity(entry.compressed_size as usize);
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|error| download_failed(entry, error))?
    {
        content.extend_from_slice(&chunk);
        if content.len() as u64 > entry.compressed_size {
            return Err(Error::Validation(format!(
                "The {} module file is larger than this version of Nexo expects; it was not installed",
                entry.name
            )));
        }
        received(content.len() as u64);
    }
    Ok(content)
}
