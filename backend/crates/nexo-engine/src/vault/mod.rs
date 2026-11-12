//! AES-256-GCM secret vault, one JSON file per owner, compatible with earlier versions.
//!
//! Version 2 entries bind every ciphertext to its owner and name with additional
//! authenticated data. Version 3 entries also keep the hosts the secret may be sent to
//! (Postman's "allowed domains"), bound by the same data so they cannot be edited in the
//! file. Version 1 entries (no AAD) stay readable and are re-encrypted on the next write.
//! The file format stays version 2, so earlier versions still open the vault; they cannot
//! decrypt restricted entries, which keeps them from sending those anywhere. Writes are
//! serialized and atomic.

mod crypto;

use crate::hex;
use aws_lc_rs::{
    aead::{AES_256_GCM, Aad, LessSafeKey, Nonce, UnboundKey},
    digest,
    rand::{SecureRandom, SystemRandom},
};
use nexo_domain::{Error, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
};
use tokio::sync::Mutex;

/// Version of the file, and of entries without allowed hosts.
const VERSION: u64 = 2;
/// Version of entries with allowed hosts.
const RESTRICTED: u64 = 3;
const RESERVED: [&str; 3] = ["__proto__", "constructor", "prototype"];

#[derive(Clone, Debug, Serialize, Deserialize)]
struct Entry {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    v: Option<u64>,
    iv: String,
    tag: String,
    data: String,
    /// Hosts the secret may be sent to; empty allows every host.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    hosts: Vec<String>,
}

pub fn validate_name(name: &str) -> Result<&str> {
    if name.trim().is_empty()
        || name.len() > 200
        || name.chars().any(|c| c == '{' || c == '}' || c.is_control())
        || RESERVED.contains(&name)
    {
        return Err(Error::Validation(
            "Secret names need 1-200 characters without braces or control characters".into(),
        ));
    }
    Ok(name)
}

/// Reads the master key from `NEXO_MASTER_KEY`-style hex, or from `<data>/master.key`,
/// creating it on first use.
pub fn load_master_key(data: &Path, configured: Option<String>) -> Result<[u8; 32]> {
    let text = match configured.filter(|key| !key.trim().is_empty()) {
        Some(key) => key,
        None => {
            let path = data.join("master.key");
            match std::fs::read_to_string(&path) {
                Ok(text) => text,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                    let key: [u8; 32] = rand_bytes();
                    std::fs::create_dir_all(data).map_err(infrastructure)?;
                    write_private(&path, hex::encode(key).as_bytes())?;
                    hex::encode(key)
                }
                Err(error) => return Err(infrastructure(error)),
            }
        }
    };
    let bytes = hex::decode(text.trim()).ok_or_else(|| {
        Error::Validation("The master key must be 64 hexadecimal characters".into())
    })?;
    bytes
        .try_into()
        .map_err(|_| Error::Validation("The master key must be 64 hexadecimal characters".into()))
}

/// Random bytes from the operating system generator.
pub fn rand_bytes<const N: usize>() -> [u8; N] {
    let mut bytes = [0u8; N];
    SystemRandom::new()
        .fill(&mut bytes)
        .expect("the operating system random generator is unavailable");
    bytes
}
fn infrastructure(error: impl std::fmt::Display) -> Error {
    Error::Infrastructure(error.to_string())
}
fn write_private(path: &Path, content: &[u8]) -> Result<()> {
    std::fs::write(path, content).map_err(infrastructure)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))
            .map_err(infrastructure)?;
    }
    Ok(())
}
/// Writes through a temporary file so readers never observe a partial file.
pub fn write_atomic(path: &Path, content: &[u8]) -> Result<()> {
    let temporary = path.with_extension(format!("{}.tmp", uuid::Uuid::new_v4().simple()));
    write_private(&temporary, content)?;
    std::fs::rename(&temporary, path).map_err(|error| {
        let _ = std::fs::remove_file(&temporary);
        infrastructure(error)
    })
}
pub fn owner_file(directory: &Path, owner: &str) -> PathBuf {
    directory.join(format!(
        "{}.json",
        hex::encode(digest::digest(&digest::SHA256, owner.as_bytes()))
    ))
}

pub struct Vault {
    directory: PathBuf,
    key: LessSafeKey,
    owner: String,
    lock: Mutex<()>,
}
impl Vault {
    pub fn new(directory: PathBuf, key: [u8; 32], owner: &str) -> Self {
        Self {
            directory,
            key: LessSafeKey::new(
                UnboundKey::new(&AES_256_GCM, &key).expect("a 32-byte key is an AES-256 key"),
            ),
            owner: owner.to_string(),
            lock: Mutex::new(()),
        }
    }
    fn path(&self) -> PathBuf {
        owner_file(&self.directory, &self.owner)
    }

    pub async fn get(&self, name: &str) -> Result<String> {
        let name = validate_name(name)?;
        let _guard = self.lock.lock().await;
        let entries = self.read()?;
        let entry = entries
            .get(name)
            .ok_or_else(|| Error::Validation(format!("Secret not found: {name}")))?;
        self.decrypt(name, entry)
    }
    /// Stores a value, keeping the secret's allowed hosts.
    pub async fn put(&self, name: &str, value: &str) -> Result<()> {
        self.store(name, Some(value), None).await
    }

    pub async fn remove(&self, name: &str) -> Result<()> {
        let name = validate_name(name)?;
        let _guard = self.lock.lock().await;
        let mut entries = self.read()?;
        entries.remove(name);
        self.write(entries)
    }
    pub async fn names(&self) -> Result<Vec<String>> {
        let _guard = self.lock.lock().await;
        Ok(self.read()?.into_keys().collect())
    }
    /// Every secret's name with its allowed hosts (empty allows every host), never values.
    pub async fn hosts(&self) -> Result<BTreeMap<String, Vec<String>>> {
        let _guard = self.lock.lock().await;
        Ok(self
            .read()?
            .into_iter()
            .map(|(name, entry)| (name, entry.hosts))
            .collect())
    }
    /// Re-encrypts every secret with a new master key.
    pub async fn rotate(&self, next: [u8; 32]) -> Result<Vault> {
        let _guard = self.lock.lock().await;
        let entries = self.read()?;
        let rotated = Vault::new(self.directory.clone(), next, &self.owner);
        let mut values = BTreeMap::new();
        for (name, entry) in &entries {
            values.insert(
                name.clone(),
                rotated.encrypt(name, &self.decrypt(name, entry)?, &entry.hosts)?,
            );
        }
        rotated.write(values)?;
        Ok(rotated)
    }
}

#[cfg(test)]
mod tests;
