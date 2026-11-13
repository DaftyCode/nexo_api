//! TLS for drivers: rustls on aws-lc-rs, Nexo's only provider, preferring post-quantum key
//! exchange (the `prefer-post-quantum` feature puts X25519MLKEM768 first).
use crate::{
    DriverError, Result,
    protocol::{TlsMode, TlsSettings},
};
use rustls::{
    ClientConfig, DigitallySignedStruct, RootCertStore, SignatureScheme,
    client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier},
    crypto::{CryptoProvider, WebPkiSupportedAlgorithms, aws_lc_rs},
};
use rustls_pki_types::{CertificateDer, PrivateKeyDer, ServerName, UnixTime, pem::PemObject};
use std::sync::Arc;

/// Accepts any server certificate: [`TlsMode::Require`] and [`TlsMode::Prefer`] encrypt
/// without checking who answers, as the engines that have those modes define them.
#[derive(Debug)]
struct AcceptAny(WebPkiSupportedAlgorithms);
impl ServerCertVerifier for AcceptAny {
    fn verify_server_cert(
        &self,
        _: &CertificateDer<'_>,
        _: &[CertificateDer<'_>],
        _: &ServerName<'_>,
        _: &[u8],
        _: UnixTime,
    ) -> std::result::Result<ServerCertVerified, rustls::Error> {
        Ok(ServerCertVerified::assertion())
    }
    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> std::result::Result<HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls12_signature(message, cert, dss, &self.0)
    }
    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> std::result::Result<HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls13_signature(message, cert, dss, &self.0)
    }
    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.0.supported_schemes()
    }
}

fn invalid(what: &str, error: impl std::fmt::Display) -> DriverError {
    DriverError::tls(format!("Invalid {what}: {error}"))
}

/// The provider every driver uses.
pub fn provider() -> Arc<CryptoProvider> {
    Arc::new(aws_lc_rs::default_provider())
}

/// The client configuration of a connection: the system's certificate authorities plus the
/// connection's own, and its client certificate. `None` when the connection does not use
/// TLS.
pub fn client_config(settings: &TlsSettings) -> Result<Option<Arc<ClientConfig>>> {
    if settings.mode == TlsMode::Disable {
        return Ok(None);
    }
    let provider = provider();
    let builder = ClientConfig::builder_with_provider(provider.clone())
        .with_safe_default_protocol_versions()
        .map_err(|error| DriverError::tls(error.to_string()))?;
    let builder = if settings.mode == TlsMode::Verify {
        let mut roots = RootCertStore::empty();
        for certificate in rustls_native_certs::load_native_certs().certs {
            let _ = roots.add(certificate);
        }
        if let Some(pem) = text(&settings.ca_pem) {
            for certificate in CertificateDer::pem_slice_iter(pem.as_bytes()) {
                let certificate = certificate.map_err(|error| invalid("CA certificate", error))?;
                roots
                    .add(certificate)
                    .map_err(|error| invalid("CA certificate", error))?;
            }
        }
        builder.with_root_certificates(roots)
    } else {
        builder
            .dangerous()
            .with_custom_certificate_verifier(Arc::new(AcceptAny(
                provider.signature_verification_algorithms,
            )))
    };
    let config = match (text(&settings.cert_pem), text(&settings.key_pem)) {
        (Some(certificate), Some(key)) => {
            let chain = CertificateDer::pem_slice_iter(certificate.as_bytes())
                .collect::<std::result::Result<Vec<_>, _>>()
                .map_err(|error| invalid("client certificate", error))?;
            let key = PrivateKeyDer::from_pem_slice(key.as_bytes())
                .map_err(|error| invalid("client key", error))?;
            builder
                .with_client_auth_cert(chain, key)
                .map_err(|error| invalid("client certificate", error))?
        }
        (None, None) => builder.with_no_client_auth(),
        _ => {
            return Err(DriverError::tls(
                "A client certificate needs its key, and a key its certificate",
            ));
        }
    };
    Ok(Some(Arc::new(config)))
}

fn text(value: &Option<String>) -> Option<&str> {
    value.as_deref().filter(|text| !text.trim().is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ErrorCode;

    #[test]
    fn prefers_post_quantum_key_exchange() {
        assert_eq!(
            provider().kx_groups[0].name(),
            rustls::NamedGroup::X25519MLKEM768
        );
    }

    #[test]
    fn builds_a_configuration_for_each_mode() {
        let settings = |mode| TlsSettings {
            mode,
            ..TlsSettings::default()
        };
        assert!(
            client_config(&settings(TlsMode::Disable))
                .unwrap()
                .is_none()
        );
        for mode in [TlsMode::Prefer, TlsMode::Require, TlsMode::Verify] {
            assert!(
                client_config(&settings(mode)).unwrap().is_some(),
                "{mode:?}"
            );
        }
    }

    #[test]
    fn a_client_certificate_needs_its_key() {
        let alone = TlsSettings {
            mode: TlsMode::Verify,
            cert_pem: Some("-----BEGIN CERTIFICATE-----\n".into()),
            ..TlsSettings::default()
        };
        let error = client_config(&alone).unwrap_err();
        assert_eq!(error.code, ErrorCode::Tls);
        let broken = TlsSettings {
            key_pem: Some("not a key".into()),
            ..alone
        };
        assert_eq!(client_config(&broken).unwrap_err().code, ErrorCode::Tls);
    }
}
