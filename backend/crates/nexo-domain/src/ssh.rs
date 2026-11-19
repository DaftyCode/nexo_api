//! SSH profiles (`ssh-profile` documents): how Nexo reaches a bastion to tunnel requests and
//! connections through it. The document says where and as whom; the password or private key
//! and its passphrase are vault secrets it names, never values of its own.
use crate::{Error, Result};
use serde_json::Value;

/// How a profile signs in.
pub const AUTH_METHODS: [&str; 2] = ["password", "key"];
/// Fields that would hold a secret in the document itself.
const SECRET_FIELDS: [&str; 3] = ["password", "privateKey", "passphrase"];

fn text<'a>(value: &'a Value, field: &str) -> &'a str {
    value
        .get(field)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
}

/// Checks the value of an `ssh-profile` document.
pub fn validate_profile(value: &Value) -> Result<()> {
    if SECRET_FIELDS
        .iter()
        .any(|field| value.get(field).is_some_and(|v| !v.is_null()))
    {
        return Err(Error::Validation(
            "Keep the password and the private key of an SSH profile in the vault".into(),
        ));
    }
    let host = text(value, "host");
    if host.is_empty() || host.chars().any(char::is_whitespace) {
        return Err(Error::Validation("Enter the host of the SSH server".into()));
    }
    if let Some(port) = value.get("port").filter(|port| !port.is_null()) {
        let valid = port
            .as_u64()
            .or_else(|| port.as_str().and_then(|text| text.trim().parse().ok()))
            .is_some_and(|port| (1..=65_535).contains(&port));
        if !valid {
            return Err(Error::Validation("Invalid SSH port".into()));
        }
    }
    if text(value, "username").is_empty() {
        return Err(Error::Validation("Enter the user of the SSH server".into()));
    }
    let auth = text(value, "auth");
    if !AUTH_METHODS.contains(&auth) {
        return Err(Error::Validation(
            "Choose how the SSH profile signs in: password or key".into(),
        ));
    }
    if text(value, "secret").is_empty() {
        return Err(Error::Validation(
            "An SSH profile names the vault secret of its password or key".into(),
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_profile_names_its_vault_secrets_and_keeps_none_of_its_own() {
        let profile = json!({"host": "bastion.example.com", "port": 2222, "username": "ana",
            "auth": "key", "secret": "ssh-1", "passphraseSecret": "ssh-1-passphrase"});
        assert!(validate_profile(&profile).is_ok());
        assert!(
            validate_profile(&json!({"host": "b", "username": "a", "auth": "password",
            "secret": "s", "port": "22"}))
            .is_ok()
        );
        for (field, value, message) in [
            (
                "password",
                json!("x"),
                "Keep the password and the private key of an SSH profile in the vault",
            ),
            (
                "host",
                json!("two words"),
                "Enter the host of the SSH server",
            ),
            ("port", json!(70000), "Invalid SSH port"),
            ("port", json!("ssh"), "Invalid SSH port"),
            ("username", json!(" "), "Enter the user of the SSH server"),
            (
                "auth",
                json!("agent"),
                "Choose how the SSH profile signs in: password or key",
            ),
            (
                "secret",
                json!(""),
                "An SSH profile names the vault secret of its password or key",
            ),
        ] {
            let mut wrong = profile.clone();
            wrong[field] = value;
            assert_eq!(
                validate_profile(&wrong).unwrap_err().to_string(),
                message,
                "{field}"
            );
        }
    }
}
