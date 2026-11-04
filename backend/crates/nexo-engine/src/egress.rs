//! Outbound connection policy.
//!
//! `allow-all` (default) lets requests reach any destination, including services on this
//! computer and its network. `deny-private` refuses loopback, private, link-local, metadata
//! and other non-public ranges after DNS resolution. `NEXO_EGRESS_ALLOW` lists hostnames,
//! IPs or IPv4 CIDRs that are always allowed.
use nexo_domain::{Error, Result};
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Policy {
    AllowAll,
    DenyPrivate { allow: Vec<String> },
}
impl Policy {
    pub fn from_env() -> Self {
        Self::parse(
            std::env::var("NEXO_EGRESS").ok().as_deref(),
            std::env::var("NEXO_EGRESS_ALLOW").ok().as_deref(),
        )
    }
    pub fn parse(policy: Option<&str>, allow: Option<&str>) -> Self {
        match policy {
            Some("deny-private") => Self::DenyPrivate {
                allow: allow
                    .unwrap_or("")
                    .split(',')
                    .map(|entry| entry.trim().to_lowercase())
                    .filter(|entry| !entry.is_empty())
                    .collect(),
            },
            _ => Self::AllowAll,
        }
    }
    /// Checks one resolved address of `host`. `loopback_ports` lets requests reach the
    /// engine's own mocks.
    pub fn check(
        &self,
        host: &str,
        address: IpAddr,
        port: u16,
        loopback_ports: &[u16],
    ) -> Result<()> {
        let Self::DenyPrivate { allow } = self else {
            return Ok(());
        };
        let host = host.trim_matches(['[', ']']).to_lowercase();
        if allow
            .iter()
            .any(|entry| entry == &host || entry == &address.to_string())
        {
            return Ok(());
        }
        if let IpAddr::V4(v4) = address
            && allow
                .iter()
                .filter_map(|entry| entry.split_once('/'))
                .any(|(base, bits)| in_cidr(v4, base, bits))
        {
            return Ok(());
        }
        if address.is_loopback() && loopback_ports.contains(&port) {
            return Ok(());
        }
        if is_private(address) {
            return Err(Error::Validation(format!(
                "Destination {host} ({address}) is blocked by the egress policy"
            )));
        }
        Ok(())
    }
    /// Resolves `host` and checks every address; returns the addresses to connect to.
    pub async fn resolve(
        &self,
        host: &str,
        port: u16,
        loopback_ports: &[u16],
    ) -> Result<Vec<SocketAddr>> {
        let host_only = host.trim_matches(['[', ']']);
        let addresses: Vec<SocketAddr> = match host_only.parse::<IpAddr>() {
            Ok(ip) => vec![SocketAddr::new(ip, port)],
            Err(_) => tokio::net::lookup_host((host_only, port))
                .await
                .map_err(|error| Error::Validation(format!("Cannot resolve {host_only}: {error}")))?
                .collect(),
        };
        for address in &addresses {
            self.check(host_only, address.ip(), port, loopback_ports)?;
        }
        Ok(addresses)
    }
}

fn in_cidr(address: Ipv4Addr, base: &str, bits: &str) -> bool {
    let (Ok(base), Ok(bits)) = (base.parse::<Ipv4Addr>(), bits.parse::<u32>()) else {
        return false;
    };
    let mask = if bits == 0 {
        0
    } else {
        u32::MAX << (32 - bits.min(32))
    };
    (u32::from(address) & mask) == (u32::from(base) & mask)
}

/// True for addresses that are not on the public Internet.
pub fn is_private(address: IpAddr) -> bool {
    match address {
        IpAddr::V4(v4) => {
            let [a, b, c, _] = v4.octets();
            v4.is_unspecified()
                || v4.is_loopback()
                || v4.is_private()
                || v4.is_link_local()
                || v4.is_broadcast()
                || v4.is_documentation()
                || v4.is_multicast()
                || a == 0
                || (a == 100 && (64..128).contains(&b))
                || (a == 192 && b == 0 && c == 0)
                || (a == 198 && (18..20).contains(&b))
                || a >= 240
        }
        IpAddr::V6(v6) => {
            if let Some(mapped) = v6.to_ipv4_mapped() {
                return is_private(IpAddr::V4(mapped));
            }
            let first = v6.segments()[0];
            v6.is_unspecified()
                || v6.is_loopback()
                || v6.is_multicast()
                || (first & 0xfe00) == 0xfc00
                || (first & 0xffc0) == 0xfe80
                || (first == 0x2001 && v6.segments()[1] == 0x0db8)
                || nat64(v6).is_some_and(|v4| is_private(IpAddr::V4(v4)))
        }
    }
}
fn nat64(v6: Ipv6Addr) -> Option<Ipv4Addr> {
    let s = v6.segments();
    (s[0] == 0x64 && s[1] == 0xff9b && s[2..6] == [0, 0, 0, 0]).then(|| {
        let [a, b] = s[6].to_be_bytes();
        let [c, d] = s[7].to_be_bytes();
        Ipv4Addr::new(a, b, c, d)
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn classifies_private_addresses() {
        for address in [
            "127.0.0.1",
            "10.1.2.3",
            "169.254.169.254",
            "192.168.0.1",
            "::1",
            "fd00::1",
            "::ffff:127.0.0.1",
            "100.64.0.1",
        ] {
            assert!(is_private(address.parse().unwrap()), "{address}");
        }
        for address in ["8.8.8.8", "1.1.1.1", "2606:4700::1111"] {
            assert!(!is_private(address.parse().unwrap()), "{address}");
        }
    }
    #[test]
    fn deny_private_honours_allow_list_and_mock_ports() {
        let policy = Policy::parse(Some("deny-private"), Some("internal.test,10.0.0.0/8"));
        let local: IpAddr = "127.0.0.1".parse().unwrap();
        assert!(policy.check("x", local, 80, &[]).is_err());
        assert!(policy.check("x", local, 4567, &[4567]).is_ok());
        assert!(
            policy
                .check("internal.test", "192.168.1.1".parse().unwrap(), 80, &[])
                .is_ok()
        );
        assert!(
            policy
                .check("y", "10.9.9.9".parse().unwrap(), 80, &[])
                .is_ok()
        );
        assert!(Policy::parse(None, None).check("x", local, 80, &[]).is_ok());
    }
}
