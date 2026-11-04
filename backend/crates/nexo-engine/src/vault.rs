//! AES-256-GCM secret vault, one JSON file per owner, compatible with earlier versions.
//!
//! Version 2 entries bind every ciphertext to its owner and name with additional
//! authenticated data. Version 1 entries (no AAD) stay readable and are re-encrypted on the
//! next write. Writes are serialized and atomic.
use aes_gcm::{
    Aes256Gcm, KeyInit, Nonce,
    aead::{Aead, Payload},
};
use nexo_domain::{Error, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
};
use tokio::sync::Mutex;

const VERSION: u64 = 2;
const RESERVED: [&str; 3] = ["__proto__", "constructor", "prototype"];

#[derive(Clone, Debug, Serialize, Deserialize)]
struct Entry {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    v: Option<u64>,
    iv: String,
    tag: String,
    data: String,
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
    let bytes = hex::decode(text.trim()).map_err(|_| {
        Error::Validation("The master key must be 64 hexadecimal characters".into())
    })?;
    bytes
        .try_into()
        .map_err(|_| Error::Validation("The master key must be 64 hexadecimal characters".into()))
}

/// Random bytes from the operating system generator.
pub fn rand_bytes<const N: usize>() -> [u8; N] {
    let mut bytes = [0u8; N];
    getrandom::fill(&mut bytes).expect("the operating system random generator is unavailable");
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
        hex::encode(Sha256::digest(owner.as_bytes()))
    ))
}

pub struct Vault {
    directory: PathBuf,
    cipher: Aes256Gcm,
    owner: String,
    lock: Mutex<()>,
}
impl Vault {
    pub fn new(directory: PathBuf, key: [u8; 32], owner: &str) -> Self {
        Self {
            directory,
            cipher: Aes256Gcm::new(&key.into()),
            owner: owner.to_string(),
            lock: Mutex::new(()),
        }
    }
    fn path(&self) -> PathBuf {
        owner_file(&self.directory, &self.owner)
    }
    fn aad(&self, name: &str) -> Vec<u8> {
        format!("nexo-vault:v{VERSION}\0{}\0{name}", self.owner).into_bytes()
    }
    fn read(&self) -> Result<BTreeMap<String, Entry>> {
        let text = match std::fs::read_to_string(self.path()) {
            Ok(text) => text,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Ok(BTreeMap::new());
            }
            Err(error) => return Err(infrastructure(error)),
        };
        let parsed: Value = serde_json::from_str(&text)
            .map_err(|error| infrastructure(format!("The vault file cannot be read: {error}")))?;
        let entries = if parsed["version"] == VERSION {
            parsed["secrets"].clone()
        } else {
            parsed
        };
        serde_json::from_value(entries)
            .map_err(|error| infrastructure(format!("The vault file cannot be read: {error}")))
    }
    fn decrypt(&self, name: &str, entry: &Entry) -> Result<String> {
        let failure = || {
            Error::Validation(format!(
                "Secret {name} cannot be decrypted with the current master key"
            ))
        };
        let iv = hex::decode(&entry.iv).map_err(|_| failure())?;
        let mut data = hex::decode(&entry.data).map_err(|_| failure())?;
        data.extend(hex::decode(&entry.tag).map_err(|_| failure())?);
        let nonce = Nonce::try_from(iv.as_slice()).map_err(|_| failure())?;
        let aad = if entry.v == Some(VERSION) {
            self.aad(name)
        } else {
            Vec::new()
        };
        let plain = self
            .cipher
            .decrypt(
                &nonce,
                Payload {
                    msg: &data,
                    aad: &aad,
                },
            )
            .map_err(|_| failure())?;
        String::from_utf8(plain).map_err(|_| failure())
    }
    fn encrypt(&self, name: &str, value: &str) -> Result<Entry> {
        let iv: [u8; 12] = rand_bytes();
        let aad = self.aad(name);
        let sealed = self
            .cipher
            .encrypt(
                &Nonce::from(iv),
                Payload {
                    msg: value.as_bytes(),
                    aad: &aad,
                },
            )
            .map_err(infrastructure)?;
        let (data, tag) = sealed.split_at(sealed.len() - 16);
        Ok(Entry {
            v: Some(VERSION),
            iv: hex::encode(iv),
            tag: hex::encode(tag),
            data: hex::encode(data),
        })
    }
    fn write(&self, mut entries: BTreeMap<String, Entry>) -> Result<()> {
        // Upgrade legacy entries so every stored value is bound to its owner and name.
        let names: Vec<String> = entries.keys().cloned().collect();
        for name in names {
            if entries[&name].v != Some(VERSION)
                && let Ok(value) = self.decrypt(&name, &entries[&name])
            {
                let upgraded = self.encrypt(&name, &value)?;
                entries.insert(name, upgraded);
            }
        }
        std::fs::create_dir_all(&self.directory).map_err(infrastructure)?;
        let body = serde_json::json!({"version": VERSION, "secrets": entries});
        write_atomic(&self.path(), body.to_string().as_bytes())
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
    pub async fn put(&self, name: &str, value: &str) -> Result<()> {
        let name = validate_name(name)?;
        if value.len() > 64 * 1024 {
            return Err(Error::Validation(
                "Secret values must be text up to 64 KB".into(),
            ));
        }
        let _guard = self.lock.lock().await;
        let mut entries = self.read()?;
        entries.insert(name.to_string(), self.encrypt(name, value)?);
        self.write(entries)
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
    /// Re-encrypts every secret with a new master key.
    pub async fn rotate(&self, next: [u8; 32]) -> Result<Vault> {
        let _guard = self.lock.lock().await;
        let entries = self.read()?;
        let rotated = Vault::new(self.directory.clone(), next, &self.owner);
        let mut values = BTreeMap::new();
        for (name, entry) in &entries {
            values.insert(
                name.clone(),
                rotated.encrypt(name, &self.decrypt(name, entry)?)?,
            );
        }
        rotated.write(values)?;
        Ok(rotated)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn directory() -> PathBuf {
        let path = std::env::temp_dir().join(format!("nexo-vault-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&path).unwrap();
        path
    }
    #[tokio::test]
    async fn stores_lists_and_removes_secrets() {
        let dir = directory();
        let vault = Vault::new(dir.clone(), [7; 32], "local");
        vault.put("token", "value").await.unwrap();
        assert_eq!(vault.get("token").await.unwrap(), "value");
        assert_eq!(vault.names().await.unwrap(), ["token"]);
        vault.remove("token").await.unwrap();
        assert!(vault.get("token").await.is_err());
        assert!(vault.put("__proto__", "x").await.is_err());
        assert!(vault.put("a}b", "x").await.is_err());
        let _ = std::fs::remove_dir_all(dir);
    }
    #[tokio::test]
    async fn concurrent_writes_are_not_lost() {
        let dir = directory();
        let vault = std::sync::Arc::new(Vault::new(dir.clone(), [1; 32], "local"));
        let tasks: Vec<_> = (0..30)
            .map(|index| {
                let vault = vault.clone();
                tokio::spawn(async move { vault.put(&format!("s{index}"), "v").await.unwrap() })
            })
            .collect();
        for task in tasks {
            task.await.unwrap();
        }
        assert_eq!(vault.names().await.unwrap().len(), 30);
        let _ = std::fs::remove_dir_all(dir);
    }
    #[tokio::test]
    async fn reads_files_written_by_the_previous_engine() {
        // Written by the JavaScript engine (version 2 with AAD, plus a version 1 entry).
        let dir = directory();
        let key = [9u8; 32];
        let vault = Vault::new(dir.clone(), key, "local");
        let cipher = Aes256Gcm::new(&key.into());
        let iv = [3u8; 12];
        let sealed = cipher
            .encrypt(
                &Nonce::from(iv),
                Payload {
                    msg: b"legacy",
                    aad: b"",
                },
            )
            .unwrap();
        let (data, tag) = sealed.split_at(sealed.len() - 16);
        let legacy = serde_json::json!({"old": {"iv": hex::encode(iv), "tag": hex::encode(tag), "data": hex::encode(data)}});
        std::fs::write(owner_file(&dir, "local"), legacy.to_string()).unwrap();
        assert_eq!(vault.get("old").await.unwrap(), "legacy");
        vault.put("new", "x").await.unwrap();
        let file: Value =
            serde_json::from_str(&std::fs::read_to_string(owner_file(&dir, "local")).unwrap())
                .unwrap();
        assert_eq!(file["version"], 2);
        assert_eq!(file["secrets"]["old"]["v"], 2);
        assert_eq!(vault.get("old").await.unwrap(), "legacy");
        let rotated = vault.rotate([4; 32]).await.unwrap();
        assert_eq!(rotated.get("old").await.unwrap(), "legacy");
        assert!(
            vault.get("old").await.is_err(),
            "the old key no longer decrypts"
        );
        let _ = std::fs::remove_dir_all(dir);
    }
    #[tokio::test]
    async fn ciphertexts_are_bound_to_their_name() {
        let dir = directory();
        let vault = Vault::new(dir.clone(), [2; 32], "local");
        vault.put("a", "1").await.unwrap();
        vault.put("b", "2").await.unwrap();
        let path = owner_file(&dir, "local");
        let mut file: Value =
            serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        file["secrets"]["a"] = file["secrets"]["b"].clone();
        std::fs::write(&path, file.to_string()).unwrap();
        assert!(vault.get("a").await.is_err());
        let _ = std::fs::remove_dir_all(dir);
    }
}
