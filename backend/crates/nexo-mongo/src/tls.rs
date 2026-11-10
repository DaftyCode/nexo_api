//! Certificates for the driver, which only reads them from files (`tlsCAFile`,
//! `tlsCertificateKeyFile`). Nexo writes them to its data directory for one connection,
//! readable only by this user, and removes them when the connection ends.
use base64::Engine as _;
use nexo_domain::{Error, Result};
use std::{
    path::{Path, PathBuf},
    sync::OnceLock,
};

/// The system's certificate authorities in PEM, read once. On Windows and macOS they include
/// the public roots; enterprise roots of networks that inspect TLS are there too.
fn system_roots() -> &'static str {
    static ROOTS: OnceLock<String> = OnceLock::new();
    ROOTS.get_or_init(|| {
        rustls_native_certs::load_native_certs()
            .certs
            .iter()
            .map(|certificate| pem("CERTIFICATE", certificate.as_ref()))
            .collect()
    })
}

fn pem(label: &str, der: &[u8]) -> String {
    let encoded = base64::engine::general_purpose::STANDARD.encode(der);
    let mut out = format!("-----BEGIN {label}-----\n");
    for line in encoded.as_bytes().chunks(64) {
        out.push_str(std::str::from_utf8(line).unwrap_or_default());
        out.push('\n');
    }
    out.push_str(&format!("-----END {label}-----\n"));
    out
}

/// What a PEM field must contain, so a mistake is reported by its field and not by a path.
fn expect_pem(text: &str, field: &str, labels: &[&str]) -> Result<()> {
    if labels
        .iter()
        .any(|label| text.contains(&format!("-----BEGIN {label}-----")))
    {
        Ok(())
    } else {
        Err(Error::Validation(format!(
            "{field} must be in PEM format (-----BEGIN {}-----)",
            labels[0]
        )))
    }
}

/// Files of one connection, removed when it is dropped.
#[derive(Debug, Default)]
pub struct TlsFiles {
    pub ca: Option<PathBuf>,
    pub client: Option<PathBuf>,
}
impl Drop for TlsFiles {
    fn drop(&mut self) {
        for path in [self.ca.take(), self.client.take()].into_iter().flatten() {
            let _ = std::fs::remove_file(path);
        }
    }
}

impl TlsFiles {
    /// Writes the CA bundle (the system's and `ca_pem`) and the client certificate with its
    /// key. Without a CA of its own and without system roots, the driver's (Mozilla's) are
    /// used.
    pub fn write(
        directory: &Path,
        ca_pem: Option<&str>,
        cert_pem: Option<&str>,
        key_pem: Option<&str>,
    ) -> Result<Self> {
        let mut files = Self::default();
        let custom = ca_pem.map(str::trim).filter(|pem| !pem.is_empty());
        if let Some(custom) = custom {
            expect_pem(custom, "The CA certificate", &["CERTIFICATE"])?;
        }
        let bundle = format!("{}{}", system_roots(), custom.unwrap_or_default());
        if !bundle.trim().is_empty() {
            files.ca = Some(private_file(directory, "ca", &bundle)?);
        }
        let cert = cert_pem.map(str::trim).filter(|pem| !pem.is_empty());
        let key = key_pem.map(str::trim).filter(|pem| !pem.is_empty());
        match (cert, key) {
            (None, None) => {}
            (Some(cert), Some(key)) => {
                expect_pem(cert, "The client certificate", &["CERTIFICATE"])?;
                if key.contains("ENCRYPTED") {
                    return Err(Error::Validation(
                        "Encrypted client keys are not supported yet: use the key without a password"
                            .into(),
                    ));
                }
                expect_pem(
                    key,
                    "The client key",
                    &["PRIVATE KEY", "RSA PRIVATE KEY", "EC PRIVATE KEY"],
                )?;
                files.client = Some(private_file(
                    directory,
                    "client",
                    &format!("{cert}\n{key}\n"),
                )?);
            }
            _ => {
                return Err(Error::Validation(
                    "A client certificate needs its key, and a key its certificate".into(),
                ));
            }
        }
        Ok(files)
    }
}

/// A file only this user can read, with a name nobody can guess.
fn private_file(directory: &Path, kind: &str, content: &str) -> Result<PathBuf> {
    let failed = |error: std::io::Error| {
        Error::Infrastructure(format!("Cannot prepare the TLS certificates: {error}"))
    };
    std::fs::create_dir_all(directory).map_err(failed)?;
    let path = directory.join(format!("{}-{kind}.pem", uuid::Uuid::new_v4().simple()));
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(&path).map_err(failed)?;
    std::io::Write::write_all(&mut file, content.as_bytes()).map_err(failed)?;
    Ok(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    const CERT: &str = "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----";
    const KEY: &str = "-----BEGIN PRIVATE KEY-----\nMIIE\n-----END PRIVATE KEY-----";

    fn directory(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!("nexo-mongo-tls-{name}-{}", uuid::Uuid::new_v4()))
    }

    #[test]
    fn writes_the_bundle_and_the_client_pair_and_removes_them() {
        let dir = directory("write");
        let files = TlsFiles::write(&dir, Some(CERT), Some(CERT), Some(KEY)).unwrap();
        let ca = files.ca.clone().unwrap();
        let client = files.client.clone().unwrap();
        let bundle = std::fs::read_to_string(&ca).unwrap();
        assert!(
            bundle.ends_with(CERT),
            "the connection's CA comes after the system's"
        );
        assert!(bundle.starts_with(system_roots()));
        assert_eq!(
            std::fs::read_to_string(&client).unwrap(),
            format!("{CERT}\n{KEY}\n")
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&client).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o600);
        }
        drop(files);
        assert!(!ca.exists() && !client.exists());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn explains_what_is_wrong_with_a_certificate() {
        let dir = directory("errors");
        let error = |ca, cert, key| {
            TlsFiles::write(&dir, ca, cert, key)
                .unwrap_err()
                .to_string()
        };
        assert!(error(Some("not a pem"), None, None).contains("The CA certificate must be in PEM"));
        assert!(error(None, Some(CERT), None).contains("needs its key"));
        assert!(error(None, Some(CERT), Some(CERT)).contains("The client key must be in PEM"));
        let encrypted =
            "-----BEGIN ENCRYPTED PRIVATE KEY-----\nx\n-----END ENCRYPTED PRIVATE KEY-----";
        assert!(error(None, Some(CERT), Some(encrypted)).contains("Encrypted client keys"));
        // Blank fields are no certificate at all.
        let files = TlsFiles::write(&dir, Some("  "), Some(""), None).unwrap();
        assert!(files.client.is_none());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn pem_wraps_at_64_columns() {
        let text = pem("CERTIFICATE", &[7u8; 100]);
        let lines: Vec<&str> = text.lines().collect();
        assert_eq!(lines[0], "-----BEGIN CERTIFICATE-----");
        assert_eq!(lines[1].len(), 64);
        assert_eq!(*lines.last().unwrap(), "-----END CERTIFICATE-----");
    }
}
