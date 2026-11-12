//! Remotes: which URLs are allowed (HTTPS, SSH or scp-like, and local paths only in tests)
//! and the egress policy for their hosts.
use super::*;

/// Where a remote is, for the egress policy.
#[derive(Debug, PartialEq, Eq)]
pub(super) struct Destination {
    pub(super) host: String,
    pub(super) port: u16,
}

/// Checks a remote URL: `https://`, `ssh://` or `user@host:path`. Transport helpers
/// (`ext::`), local paths and anything that Git could read as an option are refused.
/// Returns where it connects; `None` for a `file://` remote, which only tests allow.
pub(super) fn remote_url(url: &str, allow_files: bool) -> Result<Option<Destination>> {
    let refuse = |why: &str| Err(Error::Validation(why.into()));
    let only = "Use an https:// or ssh:// address, or user@host:path";
    if url.is_empty() {
        return refuse("The remote needs a URL");
    }
    if url.len() > 2048
        || url.starts_with('-')
        || url.chars().any(|c| c.is_whitespace() || c.is_control())
    {
        return refuse(only);
    }
    // `<transport>::<address>` runs a remote helper, such as `ext::sh -c …`.
    if let Some((transport, _)) = url.split_once("::")
        && !transport.is_empty()
        && transport
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "+.-".contains(c))
    {
        return refuse(only);
    }
    if let Some((scheme, _)) = url.split_once("://") {
        let scheme = scheme.to_ascii_lowercase();
        if scheme == "file" && allow_files {
            return Ok(None);
        }
        let port = match scheme.as_str() {
            "https" => 443,
            "ssh" => 22,
            _ => return refuse(only),
        };
        let parsed = url::Url::parse(url).map_err(|_| Error::Validation(only.into()))?;
        if parsed.password().is_some() {
            return refuse(
                "Remove the password from the URL: Git asks your credential manager for it",
            );
        }
        let host = parsed
            .host_str()
            .filter(|host| !host.is_empty())
            .ok_or_else(|| Error::Validation(only.into()))?;
        return Ok(Some(Destination {
            host: host.trim_matches(['[', ']']).to_string(),
            port: parsed.port().unwrap_or(port),
        }));
    }
    // The scp-like form, `user@host:path`.
    let Some((user, rest)) = url.split_once('@') else {
        return refuse(only);
    };
    let Some((host, path)) = rest.split_once(':') else {
        return refuse(only);
    };
    let valid_host = !host.is_empty()
        && !host.starts_with(['-', '.'])
        && host
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-');
    if user.is_empty() || user.contains(['/', ':']) || !valid_host || path.is_empty() {
        return refuse(only);
    }
    Ok(Some(Destination {
        host: host.to_ascii_lowercase(),
        port: 22,
    }))
}

impl GitAdapter {
    pub(super) async fn check_url(&self, url: &str) -> Result<()> {
        if let Some(destination) = remote_url(url, self.allows_files())? {
            self.network
                .check_destination(&destination.host, destination.port)
                .await?;
        }
        Ok(())
    }
    /// The URL of a remote, checked again before Git connects to it.
    pub(super) async fn check_remote(&self, directory: &Path, remote: &str) -> Result<()> {
        let mut command = git(directory, self.protocols);
        command.args(["remote", "get-url", "--", remote]);
        let output = run(command).await?;
        if !output.status.success() {
            return Err(Error::Validation(format!(
                "There is no remote named {remote}. Add it first."
            )));
        }
        self.check_url(String::from_utf8_lossy(&output.stdout).trim())
            .await
    }
}
