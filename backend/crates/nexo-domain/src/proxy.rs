//! Proxy profiles (`proxy-profile` documents, DB-25): an HTTP or SOCKS5 proxy that requests,
//! protocols and database connections reuse by name instead of writing it again. The document
//! says where and as whom; the password is a vault secret it names, never a value of its own.
use crate::{Error, Result};
use serde_json::Value;

/// The proxies a profile may be.
pub const PROXY_PROTOCOLS: [&str; 2] = ["http", "socks5"];

fn text<'a>(value: &'a Value, field: &str) -> &'a str {
    value
        .get(field)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
}

/// Checks the value of a `proxy-profile` document.
pub fn validate_proxy_profile(value: &Value) -> Result<()> {
    if value.get("password").is_some_and(|v| !v.is_null()) {
        return Err(Error::Validation(
            "Keep the password of a proxy profile in the vault".into(),
        ));
    }
    if !PROXY_PROTOCOLS.contains(&text(value, "protocol")) {
        return Err(Error::Validation(
            "Choose the kind of proxy: HTTP or SOCKS5".into(),
        ));
    }
    let host = text(value, "host");
    if host.is_empty() || host.chars().any(char::is_whitespace) {
        return Err(Error::Validation("Enter the host of the proxy".into()));
    }
    if let Some(port) = value.get("port").filter(|port| !port.is_null()) {
        let valid = port
            .as_u64()
            .or_else(|| port.as_str().and_then(|text| text.trim().parse().ok()))
            .is_some_and(|port| (1..=65_535).contains(&port));
        if !valid {
            return Err(Error::Validation("Invalid proxy port".into()));
        }
    }
    if text(value, "username").is_empty() && !text(value, "secret").is_empty() {
        return Err(Error::Validation(
            "A proxy profile with a password names its user".into(),
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_profile_says_where_the_proxy_is_and_names_its_vault_secret() {
        for valid in [
            json!({"protocol": "socks5", "host": "proxy.lan", "port": 1080, "remoteDns": true}),
            json!({"protocol": "http", "host": "proxy", "port": "3128", "username": "ana",
                "secret": "proxy-1"}),
        ] {
            assert!(validate_proxy_profile(&valid).is_ok(), "{valid}");
        }
        for (value, message) in [
            (
                json!({"protocol": "socks5", "host": "p", "password": "x"}),
                "Keep the password of a proxy profile in the vault",
            ),
            (
                json!({"protocol": "ssh", "host": "p"}),
                "Choose the kind of proxy: HTTP or SOCKS5",
            ),
            (
                json!({"protocol": "http", "host": "a b"}),
                "Enter the host of the proxy",
            ),
            (
                json!({"protocol": "http", "host": "p", "port": 70000}),
                "Invalid proxy port",
            ),
            (
                json!({"protocol": "http", "host": "p", "secret": "proxy-1"}),
                "A proxy profile with a password names its user",
            ),
        ] {
            assert_eq!(
                validate_proxy_profile(&value).unwrap_err().to_string(),
                message
            );
        }
    }
}
