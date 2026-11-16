//! What a session is opened with: the statements it runs first and its TLS.
use super::SETTINGS;
use crate::dialect::literal;
use mysql_async::{ClientIdentity, SslOpts};
use nexo_driver_sdk::{
    DriverError, Result,
    protocol::{ConnectParams, TlsMode},
};

/// The statements a new session runs first: its character set, time zone and read-only mode.
pub(super) fn setup(params: &ConnectParams) -> Result<Vec<String>> {
    let mut statements = Vec::new();
    for (name, value) in &params.options {
        match name.as_str() {
            "charset" => {
                if value.is_empty() || !value.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
                {
                    return Err(DriverError::invalid(format!(
                        "{value} is not a character set"
                    )));
                }
                statements.push(format!("SET NAMES {value}"));
            }
            "time_zone" => statements.push(format!("SET time_zone = {}", literal(value))),
            other => {
                return Err(DriverError::invalid(format!(
                    "MySQL has no setting {other}; use {}",
                    SETTINGS.join(", ")
                )));
            }
        }
    }
    // The server refuses writes in the session: the application refuses them before, too.
    if params.read_only {
        statements.push("SET SESSION TRANSACTION READ ONLY".into());
    }
    Ok(statements)
}

pub(super) fn text(value: &Option<String>) -> Option<&str> {
    value.as_deref().filter(|text| !text.trim().is_empty())
}

/// TLS as the connection asks: checked against the system's and its own authorities, or
/// encrypted without checking who answers.
pub(super) fn tls(params: &ConnectParams) -> Result<Option<SslOpts>> {
    let settings = &params.tls;
    if settings.mode == TlsMode::Disable {
        return Ok(None);
    }
    let mut options = SslOpts::default();
    if settings.mode == TlsMode::Verify {
        let mut roots = nexo_driver_sdk::tls::native_roots();
        if let Some(pem) = text(&settings.ca_pem) {
            roots.push(pem.as_bytes().to_vec());
        }
        options = options.with_root_certs(roots.into_iter().map(Into::into).collect());
    } else {
        options = options
            .with_danger_accept_invalid_certs(true)
            .with_danger_skip_domain_validation(true);
    }
    match (text(&settings.cert_pem), text(&settings.key_pem)) {
        (Some(certificate), Some(key)) => {
            options = options.with_client_identity(Some(ClientIdentity::new(
                certificate.as_bytes().to_vec().into(),
                key.as_bytes().to_vec().into(),
            )));
        }
        (None, None) => {}
        _ => {
            return Err(DriverError::tls(
                "A client certificate needs its key, and a key its certificate",
            ));
        }
    }
    Ok(Some(options))
}
