//! TLS client settings shared by WebSocket, MQTT and Socket.IO connections. They use
//! aws-lc-rs, like reqwest's HTTP clients, and prefer post-quantum key exchange.
use nexo_domain::{Error, Result};
use rustls::{
    ClientConfig, DigitallySignedStruct, RootCertStore, SignatureScheme,
    client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier},
    crypto::{CryptoProvider, WebPkiSupportedAlgorithms, aws_lc_rs},
};
use rustls_pki_types::{CertificateDer, PrivateKeyDer, ServerName, UnixTime, pem::PemObject};
use serde_json::Value;
use std::sync::Arc;

/// Accepts any server certificate, for users who turned certificate checks off.
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

fn invalid(message: String) -> Error {
    Error::Validation(message)
}

/// Builds a client configuration from `strictSSL`, `caPem`, `certPem` and `keyPem`.
pub fn client_config(payload: &Value) -> Result<Arc<ClientConfig>> {
    let provider: Arc<CryptoProvider> = Arc::new(aws_lc_rs::default_provider());
    let builder = ClientConfig::builder_with_provider(provider.clone())
        .with_safe_default_protocol_versions()
        .map_err(|error| Error::Infrastructure(error.to_string()))?;
    let builder = if payload["strictSSL"] == false {
        builder
            .dangerous()
            .with_custom_certificate_verifier(Arc::new(AcceptAny(
                provider.signature_verification_algorithms,
            )))
    } else {
        let mut roots = RootCertStore::empty();
        for certificate in rustls_native_certs::load_native_certs().certs {
            let _ = roots.add(certificate);
        }
        if let Some(pem) = payload["caPem"]
            .as_str()
            .filter(|pem| !pem.trim().is_empty())
        {
            for certificate in CertificateDer::pem_slice_iter(pem.as_bytes()) {
                let certificate = certificate
                    .map_err(|error| invalid(format!("Invalid CA certificate: {error}")))?;
                roots
                    .add(certificate)
                    .map_err(|error| invalid(format!("Invalid CA certificate: {error}")))?;
            }
        }
        builder.with_root_certificates(roots)
    };
    let config = match (payload["certPem"].as_str(), payload["keyPem"].as_str()) {
        (Some(cert), Some(key)) if !cert.trim().is_empty() => {
            let chain = CertificateDer::pem_slice_iter(cert.as_bytes())
                .collect::<std::result::Result<Vec<_>, _>>()
                .map_err(|error| invalid(format!("Invalid client certificate: {error}")))?;
            let key = PrivateKeyDer::from_pem_slice(key.as_bytes())
                .map_err(|error| invalid(format!("Invalid client key: {error}")))?;
            builder
                .with_client_auth_cert(chain, key)
                .map_err(|error| invalid(format!("Invalid client certificate: {error}")))?
        }
        _ => builder.with_no_client_auth(),
    };
    Ok(Arc::new(config))
}

#[cfg(test)]
mod tests {
    use super::*;
    use rustls::NamedGroup;
    use serde_json::json;

    #[test]
    fn protocol_connections_prefer_post_quantum_key_exchange() {
        for payload in [json!({}), json!({"strictSSL": false})] {
            let config = client_config(&payload).expect("client configuration");
            let groups: Vec<NamedGroup> = config
                .crypto_provider()
                .kx_groups
                .iter()
                .map(|group| group.name())
                .collect();
            assert_eq!(
                groups.first(),
                Some(&NamedGroup::X25519MLKEM768),
                "{groups:?}"
            );
            assert!(
                groups.contains(&NamedGroup::X25519),
                "classic fallback: {groups:?}"
            );
        }
    }
}
