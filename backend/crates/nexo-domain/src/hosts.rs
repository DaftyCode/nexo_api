//! Hosts a vault secret may be sent to, like Postman's "allowed domains": exact host names
//! or `*.example.com` for any subdomain. An empty list allows every host.
use crate::{Error, Result};

/// Most patterns one secret keeps.
const MAX_PATTERNS: usize = 50;

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct AllowedHosts(Vec<String>);

fn invalid(pattern: &str) -> Error {
    Error::Validation(format!(
        "Allowed domain {pattern:?} is not valid: use a host name such as api.example.com, \
         *.example.com for its subdomains, or an IP address, without protocol, port or path"
    ))
}
fn is_label(label: &str) -> bool {
    (1..=63).contains(&label.len())
        && label
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
        && !label.starts_with('-')
        && !label.ends_with('-')
}
/// A normalized pattern: lowercase, without a trailing dot.
fn normalize(pattern: &str) -> Result<String> {
    let text = pattern.trim().trim_end_matches('.').to_ascii_lowercase();
    if text.starts_with('[') && text.ends_with(']') {
        return text[1..text.len() - 1]
            .parse::<std::net::Ipv6Addr>()
            .map(|address| format!("[{address}]"))
            .map_err(|_| invalid(pattern));
    }
    if let Ok(address) = text.parse::<std::net::Ipv6Addr>() {
        return Ok(format!("[{address}]"));
    }
    let name = text.strip_prefix("*.").unwrap_or(&text);
    if name.is_empty() || name.len() > 253 || !name.split('.').all(is_label) {
        return Err(invalid(pattern));
    }
    Ok(text)
}

impl AllowedHosts {
    /// Validates the patterns a person entered (also comma-separated, as Postman shows them)
    /// and removes duplicates.
    pub fn parse<S: AsRef<str>>(patterns: &[S]) -> Result<Self> {
        let mut hosts: Vec<String> = Vec::new();
        for entry in patterns {
            for pattern in entry.as_ref().split(',').filter(|p| !p.trim().is_empty()) {
                let host = normalize(pattern)?;
                if !hosts.contains(&host) {
                    hosts.push(host);
                }
            }
        }
        if hosts.len() > MAX_PATTERNS {
            return Err(Error::Validation(format!(
                "A secret can have at most {MAX_PATTERNS} allowed domains"
            )));
        }
        Ok(Self(hosts))
    }
    /// Patterns read back from storage. An invalid one never matches, so a damaged list
    /// still restricts the secret instead of allowing every host.
    pub fn stored<S: AsRef<str>>(patterns: &[S]) -> Self {
        Self(
            patterns
                .iter()
                .map(|p| normalize(p.as_ref()).unwrap_or_else(|_| "\0invalid".into()))
                .collect(),
        )
    }
    /// Whether any host is allowed (no patterns).
    pub fn is_unrestricted(&self) -> bool {
        self.0.is_empty()
    }
    pub fn patterns(&self) -> &[String] {
        &self.0
    }
    /// Whether the secret may be sent to `host`, as a URL gives it (`api.example.com`,
    /// `127.0.0.1`, `[::1]`). `*.example.com` matches its subdomains, not `example.com`.
    pub fn allows(&self, host: &str) -> bool {
        if self.0.is_empty() {
            return true;
        }
        let host = host.trim_end_matches('.').to_ascii_lowercase();
        self.0
            .iter()
            .any(|pattern| match pattern.strip_prefix("*.") {
                Some(domain) => host
                    .strip_suffix(domain)
                    .is_some_and(|prefix| prefix.len() > 1 && prefix.ends_with('.')),
                None => *pattern == host,
            })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matches_exact_hosts_and_subdomain_wildcards() {
        let hosts =
            AllowedHosts::parse(&["API.Example.com", "*.internal.test, 127.0.0.1"]).unwrap();
        assert_eq!(
            hosts.patterns(),
            ["api.example.com", "*.internal.test", "127.0.0.1"]
        );
        assert!(hosts.allows("api.example.com"));
        assert!(hosts.allows("API.EXAMPLE.COM."));
        assert!(hosts.allows("a.internal.test"));
        assert!(hosts.allows("deep.a.internal.test"));
        assert!(hosts.allows("127.0.0.1"));
        for denied in [
            "example.com",
            "evil.test",
            "internal.test",
            "xinternal.test",
            "api.example.com.evil.test",
            "evilapi.example.com",
            "127.0.0.2",
        ] {
            assert!(!hosts.allows(denied), "{denied}");
        }
    }

    #[test]
    fn an_empty_list_allows_every_host() {
        let hosts = AllowedHosts::parse::<&str>(&[]).unwrap();
        assert!(hosts.is_unrestricted());
        assert!(hosts.allows("anything.test"));
        assert!(AllowedHosts::parse(&[" , "]).unwrap().is_unrestricted());
    }

    #[test]
    fn accepts_ipv6_with_or_without_brackets() {
        let hosts = AllowedHosts::parse(&["::1", "[2001:DB8::1]"]).unwrap();
        assert_eq!(hosts.patterns(), ["[::1]", "[2001:db8::1]"]);
        assert!(hosts.allows("[::1]"));
        assert!(!hosts.allows("[::2]"));
    }

    #[test]
    fn rejects_urls_ports_paths_regex_and_bad_wildcards() {
        for pattern in [
            "https://api.example.com",
            "api.example.com:443",
            "api.example.com/v1",
            "*.example.*",
            "api.*.com",
            "*",
            "*.",
            ".*\\.example\\.com",
            "exa mple.com",
            "-bad.com",
            "münchen.de",
            "[not-ip]",
        ] {
            assert!(AllowedHosts::parse(&[pattern]).is_err(), "{pattern}");
        }
        let many: Vec<String> = (0..51).map(|i| format!("h{i}.test")).collect();
        assert!(AllowedHosts::parse(&many).is_err());
    }

    #[test]
    fn damaged_stored_patterns_never_match() {
        let hosts = AllowedHosts::stored(&["https://bad"]);
        assert!(!hosts.is_unrestricted());
        assert!(!hosts.allows("bad"));
        assert!(!hosts.allows("evil.test"));
    }
}
