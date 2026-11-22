//! TLS for Redis: the library builds its rustls configuration with the process's provider
//! (made aws-lc-rs here) from certificates in PEM. `verify` checks the server against the
//! system's authorities and the connection's own; `prefer` and `require` encrypt without
//! checking, as the other modules do.
use base64::Engine;
use nexo_driver_sdk::{
    DriverError, Result,
    protocol::{TlsMode, TlsSettings},
    tls,
};
use redis::{ClientTlsConfig, TlsCertificates};

pub(super) fn install() {
    tls::install_provider();
}

fn pem(der: &[u8]) -> String {
    let text = base64::engine::general_purpose::STANDARD.encode(der);
    let lines: Vec<&str> = text
        .as_bytes()
        .chunks(64)
        .map(|chunk| std::str::from_utf8(chunk).unwrap_or_default())
        .collect();
    format!(
        "-----BEGIN CERTIFICATE-----\n{}\n-----END CERTIFICATE-----\n",
        lines.join("\n")
    )
}

fn text(value: &Option<String>) -> Option<&str> {
    value.as_deref().filter(|text| !text.trim().is_empty())
}

/// Whether the connection skips checking the server (`prefer`, `require`), and its
/// certificates; `None` without TLS.
pub(super) fn certificates(settings: &TlsSettings) -> Result<Option<(bool, TlsCertificates)>> {
    if settings.mode == TlsMode::Disable {
        return Ok(None);
    }
    let verify = settings.mode == TlsMode::Verify;
    // With its own authority, the system's are given too: the library trusts only those
    // it is given.
    let root_cert = match text(&settings.ca_pem) {
        Some(ca) if verify => {
            let mut roots: String = tls::native_roots().iter().map(|der| pem(der)).collect();
            roots.push_str(ca);
            Some(roots.into_bytes())
        }
        _ => None,
    };
    let client_tls = match (text(&settings.cert_pem), text(&settings.key_pem)) {
        (Some(certificate), Some(key)) => Some(ClientTlsConfig {
            client_cert: certificate.as_bytes().to_vec(),
            client_key: key.as_bytes().to_vec(),
        }),
        (None, None) => None,
        _ => {
            return Err(DriverError::tls(
                "A client certificate needs its key, and a key its certificate",
            ));
        }
    };
    Ok(Some((
        !verify,
        TlsCertificates {
            client_tls,
            root_cert,
        },
    )))
}
