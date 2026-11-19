//! SSH tunnels. A session to a bastion per profile, shared by every request and connection
//! that takes it and closed after a while unused. Each tunnel listens on a loopback port as a
//! SOCKS5 proxy, with a password only this process knows, so HTTP requests (reqwest) and the
//! other protocols reach their destinations through it as through any SOCKS5 proxy, the name
//! resolved by the bastion. Server keys are checked against Nexo's own `known_hosts` and the
//! user's OpenSSH one: an unknown key waits for the person to trust it, a changed one blocks.

mod known;
mod server;
mod session;
mod tunnel;

pub use tunnel::Tunnel;

use super::text;
use crate::egress::Policy;
use aws_lc_rs::digest;
use nexo_domain::{Error, Result};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{Arc, Mutex, MutexGuard, OnceLock, atomic::Ordering},
    time::Duration,
};

/// How long a tunnel's session stays open with nothing going through it.
const IDLE: Duration = Duration::from_secs(10 * 60);

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|error| error.into_inner())
}

#[derive(Clone, PartialEq, Eq)]
pub enum SshAuth {
    Password(String),
    Key {
        pem: String,
        passphrase: Option<String>,
    },
}

/// Where and as whom a tunnel signs in, from an SSH profile and its vault secrets.
#[derive(Clone, PartialEq, Eq)]
pub struct SshTarget {
    pub profile: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub auth: SshAuth,
}
impl std::fmt::Debug for SshTarget {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            formatter,
            "SshTarget({}, {}@{}:{})",
            self.profile, self.username, self.host, self.port
        )
    }
}
impl SshTarget {
    /// From a profile the application sent along: `{host, port, username, auth}` with
    /// `password`, or `privateKey` and `passphrase`, read from the vault.
    pub fn from_profile(id: &str, profile: &Value) -> Result<Self> {
        let host = text(&profile["host"]);
        if host.is_empty() {
            return Err(Error::Validation("Enter the host of the SSH server".into()));
        }
        let port = match text(&profile["port"]).as_str() {
            "" => 22,
            port => port
                .parse::<u16>()
                .ok()
                .filter(|port| *port > 0)
                .ok_or_else(|| Error::Validation("Invalid SSH port".into()))?,
        };
        let username = text(&profile["username"]);
        if username.is_empty() {
            return Err(Error::Validation("Enter the user of the SSH server".into()));
        }
        let secret = |field: &str| profile[field].as_str().unwrap_or_default().to_string();
        let auth = if text(&profile["auth"]) == "key" {
            let pem = secret("privateKey");
            if pem.trim().is_empty() {
                return Err(Error::Validation(
                    "The private key of the SSH profile is not in the vault".into(),
                ));
            }
            let passphrase = Some(secret("passphrase")).filter(|p| !p.is_empty());
            SshAuth::Key { pem, passphrase }
        } else {
            SshAuth::Password(secret("password"))
        };
        Ok(Self {
            profile: id.to_string(),
            host,
            port,
            username,
            auth,
        })
    }
    /// What tells tunnels apart: a digest of every field, so an edited profile gets its own.
    fn identity(&self) -> String {
        let (secret, passphrase) = match &self.auth {
            SshAuth::Password(password) => (password.as_str(), ""),
            SshAuth::Key { pem, passphrase } => (pem.as_str(), passphrase.as_deref().unwrap_or("")),
        };
        let fields = json!([
            self.profile,
            self.host,
            self.port,
            self.username,
            secret,
            passphrase
        ]);
        crate::hex::encode(digest::digest(
            &digest::SHA256,
            fields.to_string().as_bytes(),
        ))
    }
    fn address(&self) -> String {
        format!("{}:{}", self.host, self.port)
    }
}

/// The tunnels of this process.
pub struct Tunnels {
    known_hosts: Mutex<Option<PathBuf>>,
    open: Mutex<HashMap<String, Arc<Tunnel>>>,
    /// The last untrusted key each server showed, to trust it when the person says so.
    shown: Mutex<HashMap<String, russh::keys::PublicKey>>,
}

static TUNNELS: OnceLock<Tunnels> = OnceLock::new();

pub fn tunnels() -> &'static Tunnels {
    TUNNELS.get_or_init(|| Tunnels {
        known_hosts: Mutex::new(None),
        open: Mutex::default(),
        shown: Mutex::default(),
    })
}

impl Tunnels {
    /// Where Nexo writes the server keys the person trusts; OpenSSH's own file is read too.
    /// The first engine of the process sets it (there is one engine per process).
    pub fn set_known_hosts(&self, path: PathBuf) {
        lock(&self.known_hosts).get_or_insert(path);
    }
    fn known_hosts(&self) -> Option<PathBuf> {
        lock(&self.known_hosts).clone()
    }

    /// The tunnel of `target`, listening on loopback from now on; its session opens when it
    /// is first needed ([`Tunnel::ensure`]).
    pub fn tunnel(
        &self,
        target: &SshTarget,
        egress: &Policy,
        loopback_ports: &[u16],
    ) -> Result<Arc<Tunnel>> {
        let mut open = lock(&self.open);
        let identity = target.identity();
        if let Some(tunnel) = open
            .get(&identity)
            .filter(|t| !t.stopped.load(Ordering::SeqCst))
        {
            return Ok(tunnel.clone());
        }
        let tunnel = Tunnel::listen(target.clone(), egress.clone(), loopback_ports.to_vec())?;
        open.insert(identity, tunnel.clone());
        Ok(tunnel)
    }

    /// Signs in to the profile's server once and closes: `{trusted, algorithm, fingerprint}`.
    /// An unknown key is not an error here, so the person can see it and trust it.
    pub async fn test(
        &self,
        target: &SshTarget,
        egress: &Policy,
        loopback_ports: &[u16],
    ) -> Result<Value> {
        let (trusted, key) = match session::open(target, self, egress, loopback_ports).await {
            Ok(opened) => {
                let _ = opened
                    .handle
                    .disconnect(russh::Disconnect::ByApplication, "", "en")
                    .await;
                (true, opened.key)
            }
            Err(session::Failure::Unknown(key, _)) => (false, *key),
            Err(other) => return Err(other.into()),
        };
        Ok(json!({
            "trusted": trusted,
            "host": target.host,
            "port": target.port,
            "algorithm": key.algorithm().to_string(),
            "fingerprint": known::fingerprint(&key),
        }))
    }

    /// Trusts the key `host:port` showed last, when it is the one with `fingerprint`.
    pub fn trust(&self, host: &str, port: u16, fingerprint: &str) -> Result<()> {
        let address = format!("{host}:{port}");
        let key = lock(&self.shown)
            .get(&address)
            .filter(|key| known::fingerprint(key) == fingerprint.trim())
            .cloned()
            .ok_or_else(|| {
                Error::Validation(format!(
                    "Test the SSH profile again: {address} has not shown that key"
                ))
            })?;
        let path = self
            .known_hosts()
            .ok_or_else(|| Error::Infrastructure("Nexo has no known_hosts file to write".into()))?;
        known::learn(&path, host, port, &key)?;
        lock(&self.shown).remove(&address);
        Ok(())
    }

    fn forget(&self, tunnel: &Arc<Tunnel>) {
        lock(&self.open).retain(|_, open| !Arc::ptr_eq(open, tunnel));
    }
}

/// `ssh.test`: the profile the payload names, from the `sshProfiles` the application sent.
pub async fn test_profile(
    payload: &Value,
    egress: &Policy,
    loopback_ports: &[u16],
) -> Result<Value> {
    let id = text(&payload["profile"]);
    let profile = &payload["sshProfiles"][&id];
    if !profile.is_object() {
        return Err(Error::Validation(
            "The SSH profile of this connection no longer exists".into(),
        ));
    }
    tunnels()
        .test(
            &SshTarget::from_profile(&id, profile)?,
            egress,
            loopback_ports,
        )
        .await
}

/// `ssh.trust`: the key `host:port` showed in its last test, when it has `fingerprint`.
pub fn trust_key(payload: &Value) -> Result<Value> {
    let port = payload["port"]
        .as_u64()
        .and_then(|port| u16::try_from(port).ok())
        .ok_or_else(|| Error::Validation("Invalid SSH port".into()))?;
    tunnels().trust(
        &text(&payload["host"]),
        port,
        &text(&payload["fingerprint"]),
    )?;
    Ok(json!({ "trusted": true }))
}

#[cfg(test)]
mod tests;
