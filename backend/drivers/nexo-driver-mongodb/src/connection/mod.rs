//! A connection as `connect` gives it, and the driver options it becomes: its URI,
//! checked, with the password, the certificates and Nexo's limits added.
use crate::error::{Error, Result};
use crate::{limits, tls::TlsFiles};
use mongodb::options::{AuthMechanism, ClientOptions, Tls, TlsOptions};
use nexo_driver_sdk::{
    document::options as names,
    protocol::{ConnectParams, ProxySettings},
};
use std::{path::Path, time::Duration};

/// A connection: its URI without a password (variables already replaced), its secrets and
/// how it reaches its servers.
#[derive(Clone, Default)]
pub struct DatabaseConnection {
    /// The name the host gave it, which `net.check` repeats.
    pub name: String,
    pub uri: String,
    pub password: Option<String>,
    /// Certificate authorities trusted besides the system's, in PEM.
    pub ca_pem: Option<String>,
    /// The client certificate and its key, in PEM, for TLS client authentication (X.509).
    pub cert_pem: Option<String>,
    pub key_pem: Option<String>,
    /// The SOCKS5 proxy of its route, when it has one.
    pub proxy: Option<ProxySettings>,
    /// Some servers may be refused: the first one is asked for the others before the
    /// driver connects to them all.
    pub check_members: bool,
}
impl std::fmt::Debug for DatabaseConnection {
    /// Never shows the password or the key, should a connection end up in a log.
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("DatabaseConnection")
            .field("uri", &self.uri)
            .field("password", &self.password.as_ref().map(|_| "[redacted]"))
            .field("key_pem", &self.key_pem.as_ref().map(|_| "[redacted]"))
            .finish_non_exhaustive()
    }
}

impl DatabaseConnection {
    /// The connection `connect` describes: the URI is the option `uri`.
    pub fn from_params(params: &ConnectParams) -> Result<Self> {
        let uri = params
            .options
            .get(names::URI)
            .filter(|uri| !uri.trim().is_empty())
            .ok_or_else(|| invalid("Write the URI of the connection (mongodb://…)"))?;
        Ok(Self {
            name: params.connection.clone(),
            uri: uri.clone(),
            password: params.password.clone(),
            ca_pem: params.tls.ca_pem.clone(),
            cert_pem: params.tls.cert_pem.clone(),
            key_pem: params.tls.key_pem.clone(),
            proxy: params.proxy.clone(),
            check_members: params
                .options
                .get(names::CHECK_MEMBERS)
                .is_some_and(|value| value == "true"),
        })
    }
}

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
mod tests;
