//! The driver options of a connection: its URI, checked, with the password, the
//! certificates and Nexo's limits added.
use crate::{limits, tls::TlsFiles};
use mongodb::options::{AuthMechanism, ClientOptions, Tls, TlsOptions};
use nexo_application::ports::DatabaseConnection;
use nexo_domain::{Error, Result};
use std::{path::Path, time::Duration};

fn invalid(message: impl Into<String>) -> Error {
    Error::Validation(message.into())
}

/// Checks what can be checked without a network: the scheme, unresolved variables and
/// options Nexo does not accept.
pub fn check_uri(uri: &str) -> Result<()> {
    if !(uri.starts_with("mongodb://") || uri.starts_with("mongodb+srv://")) {
        return Err(invalid(
            "A MongoDB URI starts with mongodb:// or mongodb+srv://",
        ));
    }
    if let Some(start) = uri.find("{{") {
        let name = uri[start..]
            .split("}}")
            .next()
            .unwrap_or_default()
            .trim_start_matches('{');
        return Err(invalid(format!(
            "The URI uses {{{{{name}}}}}, which is not defined in the active environment"
        )));
    }
    let query = uri.split_once('?').map(|(_, query)| query).unwrap_or("");
    let enabled = |name: &str| {
        query.split('&').any(|option| {
            option
                .split_once('=')
                .is_some_and(|(key, value)| key.eq_ignore_ascii_case(name) && value == "true")
        })
    };
    for option in query.split('&') {
        let key = option.split('=').next().unwrap_or_default();
        if [
            "tlscafile",
            "tlscertificatekeyfile",
            "tlscertificatekeyfilepassword",
        ]
        .contains(&key.to_ascii_lowercase().as_str())
        {
            return Err(invalid(format!(
                "Nexo does not read files named in a URI ({key}): paste the certificates in the connection's TLS settings"
            )));
        }
    }
    // With rustls the driver always checks the host name; skipping it only makes sense when
    // the certificate is not checked at all.
    if enabled("tlsAllowInvalidHostnames")
        && !enabled("tlsAllowInvalidCertificates")
        && !enabled("tlsInsecure")
    {
        return Err(invalid(
            "Invalid host names cannot be allowed on their own: allow invalid certificates instead (tlsAllowInvalidCertificates=true)",
        ));
    }
    Ok(())
}

/// Builds the driver options of a connection. The returned files hold its certificates and
/// must live as long as its client.
pub async fn options(
    connection: &DatabaseConnection,
    tls_directory: &Path,
) -> Result<(ClientOptions, TlsFiles)> {
    let uri = connection.uri.trim();
    check_uri(uri)?;
    let mut options = ClientOptions::parse(uri)
        .await
        .map_err(crate::errors::driver)?;

    if let Some(credential) = &options.credential {
        match &credential.mechanism {
            None
            | Some(AuthMechanism::ScramSha1)
            | Some(AuthMechanism::ScramSha256)
            | Some(AuthMechanism::MongoDbX509) => {}
            Some(other) => {
                return Err(invalid(format!(
                    "The {} authentication mechanism is not supported yet; use SCRAM-SHA-256, SCRAM-SHA-1 or X.509",
                    other.as_str()
                )));
            }
        }
    }
    let password = connection.password.as_deref().filter(|p| !p.is_empty());
    if let Some(password) = password {
        if options
            .credential
            .as_ref()
            .is_some_and(|credential| credential.mechanism == Some(AuthMechanism::MongoDbX509))
        {
            return Err(invalid(
                "X.509 authentication uses the client certificate, not a password",
            ));
        }
        let Some(credential) = options
            .credential
            .as_mut()
            .filter(|credential| credential.username.is_some())
        else {
            return Err(invalid(
                "Add the user name to the URI (mongodb://user@host) to sign in with a password",
            ));
        };
        if credential.password.is_some() {
            return Err(invalid(
                "The URI already has a password: keep it only in the password field",
            ));
        }
        credential.password = Some(password.to_string());
    }

    options.app_name.get_or_insert_with(|| "Nexo API".into());
    options
        .server_selection_timeout
        .get_or_insert(limits::SERVER_SELECTION);
    options.connect_timeout.get_or_insert(limits::CONNECT);
    options.max_pool_size.get_or_insert(limits::POOL);
    options
        .max_idle_time
        .get_or_insert(Duration::from_secs(300));

    let has = |field: &Option<String>| field.as_deref().is_some_and(|text| !text.trim().is_empty());
    let material = has(&connection.ca_pem) || has(&connection.cert_pem) || has(&connection.key_pem);
    let mut tls = match options.tls.take() {
        Some(Tls::Enabled(tls)) => tls,
        Some(Tls::Disabled) if material => {
            return Err(invalid(
                "TLS is off in this URI (tls=false): turn it on to use certificates",
            ));
        }
        Some(Tls::Disabled) => {
            options.tls = Some(Tls::Disabled);
            return Ok((options, TlsFiles::default()));
        }
        None if material => TlsOptions::default(),
        None => return Ok((options, TlsFiles::default())),
    };
    if tls.ca_file_path.is_some() || tls.cert_key_file_path.is_some() {
        return Err(invalid(
            "Nexo does not read files named in a URI: paste the certificates in the connection's TLS settings",
        ));
    }
    let files = TlsFiles::write(
        tls_directory,
        connection.ca_pem.as_deref(),
        connection.cert_pem.as_deref(),
        connection.key_pem.as_deref(),
    )?;
    tls.ca_file_path = files.ca.clone();
    tls.cert_key_file_path = files.client.clone();
    options.tls = Some(Tls::Enabled(tls));
    Ok((options, files))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn connection(uri: &str) -> DatabaseConnection {
        DatabaseConnection {
            uri: uri.into(),
            ..Default::default()
        }
    }
    fn directory() -> std::path::PathBuf {
        std::env::temp_dir().join(format!("nexo-mongo-options-{}", uuid::Uuid::new_v4()))
    }
    async fn error(connection: DatabaseConnection) -> String {
        options(&connection, &directory())
            .await
            .unwrap_err()
            .to_string()
    }

    #[test]
    fn refuses_other_schemes_undefined_variables_and_files() {
        assert!(check_uri("postgres://db").is_err());
        assert!(check_uri("mongodb://db.test:27017/app?replicaSet=rs0").is_ok());
        let undefined = check_uri("mongodb://{{host}}:27017")
            .unwrap_err()
            .to_string();
        assert!(undefined.contains("{{host}}"), "{undefined}");
        for option in [
            "tlsCAFile",
            "TLSCertificateKeyFile",
            "tlsCertificateKeyFilePassword",
        ] {
            let uri = format!("mongodb://db.test/?tls=true&{option}=/etc/x.pem");
            assert!(
                check_uri(&uri).unwrap_err().to_string().contains(option),
                "{option}"
            );
        }
    }

    #[tokio::test]
    async fn adds_the_password_and_nexo_limits_without_overriding_the_uri() {
        let mut with_password = connection(
            "mongodb://ana@db1.test:27018,db2.test/app?authSource=admin&serverSelectionTimeoutMS=500&appName=Mine",
        );
        with_password.password = Some("p@ss:word".into());
        let (built, files) = options(&with_password, &directory()).await.unwrap();
        let credential = built.credential.unwrap();
        assert_eq!(credential.username.as_deref(), Some("ana"));
        assert_eq!(credential.password.as_deref(), Some("p@ss:word"));
        assert_eq!(credential.source.as_deref(), Some("admin"));
        assert_eq!(built.hosts.len(), 2);
        assert_eq!(
            built.server_selection_timeout,
            Some(Duration::from_millis(500))
        );
        assert_eq!(built.app_name.as_deref(), Some("Mine"));
        assert_eq!(built.connect_timeout, Some(limits::CONNECT));
        assert_eq!(built.max_pool_size, Some(limits::POOL));
        assert!(built.tls.is_none() && files.ca.is_none());

        let (built, _) = options(&connection("mongodb://db.test"), &directory())
            .await
            .unwrap();
        assert_eq!(built.app_name.as_deref(), Some("Nexo API"));
    }

    #[tokio::test]
    async fn explains_credentials_that_cannot_work() {
        let mut no_user = connection("mongodb://db.test");
        no_user.password = Some("secret".into());
        assert!(error(no_user).await.contains("Add the user name"));
        let mut x509 = connection("mongodb://db.test/?authMechanism=MONGODB-X509&tls=true");
        x509.password = Some("secret".into());
        assert!(error(x509).await.contains("X.509"));
        let plain = connection("mongodb://ana:x@db.test/?authMechanism=PLAIN");
        let plain = error(plain).await;
        assert!(
            plain.contains("PLAIN authentication mechanism is not supported yet"),
            "{plain}"
        );
        let mut twice = connection("mongodb://ana:inline@db.test");
        twice.password = Some("secret".into());
        assert!(error(twice).await.contains("already has a password"));
    }

    #[tokio::test]
    async fn certificates_turn_tls_on_unless_the_uri_turns_it_off() {
        let dir = directory();
        let cert = "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----";
        let mut with_ca = connection("mongodb://db.test");
        with_ca.ca_pem = Some(cert.into());
        let (built, files) = options(&with_ca, &dir).await.unwrap();
        let Some(Tls::Enabled(tls)) = built.tls else {
            panic!("TLS is on")
        };
        assert_eq!(tls.ca_file_path, files.ca);
        assert!(files.ca.as_ref().unwrap().starts_with(&dir));

        let mut off = connection("mongodb://db.test/?tls=false");
        off.ca_pem = Some(cert.into());
        assert!(error(off).await.contains("TLS is off"));
        let hostnames = connection("mongodb://db.test/?tls=true&tlsAllowInvalidHostnames=true");
        assert!(
            error(hostnames)
                .await
                .contains("allow invalid certificates instead")
        );
        let (built, _) = options(
            &connection("mongodb://db.test/?tlsInsecure=true"),
            &directory(),
        )
        .await
        .unwrap();
        let Some(Tls::Enabled(tls)) = built.tls else {
            panic!("TLS is on")
        };
        assert_eq!(tls.allow_invalid_certificates, Some(true));
        drop(files);
        let _ = std::fs::remove_dir_all(dir);
    }
}
