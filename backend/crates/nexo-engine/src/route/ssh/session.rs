//! The session to a bastion: TCP to it within the egress policy, its key checked, then the
//! sign-in with a password or a private key (with its passphrase).
use super::{SshAuth, SshTarget, Tunnels, known, lock};
use crate::egress::Policy;
use nexo_domain::Error;
use russh::{
    client::{self, Handle},
    keys::{PrivateKeyWithHashAlg, PublicKey, PublicKeyOrCertificate},
};
use std::{
    path::PathBuf,
    sync::{Arc, Mutex},
    time::Duration,
};

const CONNECT: Duration = Duration::from_secs(15);
const HANDSHAKE: Duration = Duration::from_secs(30);

/// What the SSH library calls back while connecting: it checks the server's key.
pub(crate) struct Client {
    host: String,
    port: u16,
    known_hosts: Option<PathBuf>,
    seen: Arc<Mutex<Option<(known::Verdict, PublicKey)>>>,
}

impl client::Handler for Client {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        server: &PublicKeyOrCertificate,
    ) -> Result<bool, Self::Error> {
        // Nexo asks for plain keys, never certificates.
        let PublicKeyOrCertificate::PublicKey { key, .. } = server else {
            return Ok(false);
        };
        let verdict = known::check(&self.host, self.port, key, self.known_hosts.as_deref());
        *lock(&self.seen) = Some((verdict, key.clone()));
        Ok(verdict == known::Verdict::Known)
    }
}

/// Why a session did not open: a key to trust or a changed key, or anything else. Keys are
/// boxed: the error stays small on the happy path.
pub(super) enum Failure {
    Unknown(Box<PublicKey>, String),
    Changed(Box<PublicKey>, String),
    Other(Error),
}

impl From<Failure> for Error {
    fn from(failure: Failure) -> Self {
        match failure {
            Failure::Unknown(key, address) => Error::Validation(format!(
                "The SSH server {address} is not trusted yet. Its key is {} {}: check it and trust it in the SSH profile",
                key.algorithm(),
                known::fingerprint(&key)
            )),
            Failure::Changed(key, address) => Error::Validation(format!(
                "The key of the SSH server {address} changed to {} {}: the connection is blocked in case someone is in between. If the server's key really changed, remove the old one from known_hosts",
                key.algorithm(),
                known::fingerprint(&key)
            )),
            Failure::Other(error) => error,
        }
    }
}

pub(super) struct Opened {
    pub handle: Handle<Client>,
    pub key: PublicKey,
}

fn refused(message: String) -> Failure {
    Failure::Other(Error::Validation(message))
}

pub(super) async fn open(
    target: &SshTarget,
    tunnels: &Tunnels,
    egress: &Policy,
    loopback_ports: &[u16],
) -> Result<Opened, Failure> {
    let address = target.address();
    let addresses = egress
        .resolve(&target.host, target.port, loopback_ports)
        .await
        .map_err(Failure::Other)?;
    let tcp = tokio::time::timeout(CONNECT, tokio::net::TcpStream::connect(&addresses[..]))
        .await
        .map_err(|_| refused(format!("Connecting to the SSH server {address} timed out")))?
        .map_err(|error| {
            refused(format!(
                "Cannot connect to the SSH server {address}: {error}"
            ))
        })?;
    let _ = tcp.set_nodelay(true);
    let seen = Arc::default();
    let client = Client {
        host: target.host.clone(),
        port: target.port,
        known_hosts: tunnels.known_hosts(),
        seen: Arc::clone(&seen),
    };
    let config = Arc::new(client::Config {
        keepalive_interval: Some(Duration::from_secs(30)),
        ..Default::default()
    });
    let connected =
        tokio::time::timeout(HANDSHAKE, client::connect_stream(config, tcp, client)).await;
    let shown = lock(&seen).take();
    let mut handle = match connected {
        Ok(Ok(handle)) => handle,
        Ok(Err(error)) => {
            return Err(match shown {
                Some((known::Verdict::Unknown, key)) => {
                    lock(&tunnels.shown).insert(address.clone(), key.clone());
                    Failure::Unknown(Box::new(key), address)
                }
                Some((known::Verdict::Changed, key)) => Failure::Changed(Box::new(key), address),
                _ => refused(format!("The SSH connection to {address} failed: {error}")),
            });
        }
        Err(_) => {
            return Err(refused(format!(
                "The SSH server {address} did not answer in time"
            )));
        }
    };
    let key = shown
        .map(|(_, key)| key)
        .ok_or_else(|| refused(format!("The SSH server {address} showed no key")))?;
    authenticate(&mut handle, target).await?;
    Ok(Opened { handle, key })
}

async fn authenticate(handle: &mut Handle<Client>, target: &SshTarget) -> Result<(), Failure> {
    let address = target.address();
    let (result, what) = match &target.auth {
        SshAuth::Password(password) => (
            handle
                .authenticate_password(target.username.clone(), password.clone())
                .await,
            "password",
        ),
        SshAuth::Key { pem, passphrase } => {
            let key =
                russh::keys::decode_secret_key(pem, passphrase.as_deref()).map_err(|error| {
                    refused(format!(
                        "The private key of the SSH profile cannot be read: {error}"
                    ))
                })?;
            let hash = handle
                .best_supported_rsa_hash()
                .await
                .ok()
                .flatten()
                .flatten();
            let key = PrivateKeyWithHashAlg::new(Arc::new(key), hash);
            (
                handle
                    .authenticate_publickey(target.username.clone(), key)
                    .await,
                "key",
            )
        }
    };
    let result = result.map_err(|error| {
        refused(format!(
            "Signing in to the SSH server {address} failed: {error}"
        ))
    })?;
    if result.success() {
        Ok(())
    } else {
        Err(refused(format!(
            "The SSH server {address} refused the user {} with that {what}",
            target.username
        )))
    }
}
