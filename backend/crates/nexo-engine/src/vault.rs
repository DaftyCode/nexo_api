//! AES-256-GCM secret vault, one JSON file per owner, compatible with earlier versions.
//!
//! Version 2 entries bind every ciphertext to its owner and name with additional
//! authenticated data. Version 1 entries (no AAD) stay readable and are re-encrypted on the
//! next write. Writes are serialized and atomic.
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
        let iv = hex::decode(&entry.iv).ok_or_else(failure)?;
        // The ciphertext followed by its 16-byte tag, as AES-GCM opens it.
        let mut data = hex::decode(&entry.data).ok_or_else(failure)?;
        data.extend(hex::decode(&entry.tag).ok_or_else(failure)?);
        let nonce = Nonce::try_assume_unique_for_key(&iv).map_err(|_| failure())?;
        let aad = if entry.v == Some(VERSION) {
            self.aad(name)
        } else {
            Vec::new()
        };
        let plain = self
            .key
            .open_in_place(nonce, Aad::from(aad), &mut data)
            .map_err(|_| failure())?;
        String::from_utf8(plain.to_vec()).map_err(|_| failure())
    }
    fn encrypt(&self, name: &str, value: &str) -> Result<Entry> {
        let iv: [u8; 12] = rand_bytes();
        let aad = self.aad(name);
        let mut sealed = value.as_bytes().to_vec();
        self.key
            .seal_in_place_append_tag(
                Nonce::assume_unique_for_key(iv),
                Aad::from(aad),
                &mut sealed,
            )
            .map_err(infrastructure)?;
        let (data, tag) = sealed.split_at(sealed.len() - AES_256_GCM.tag_len());
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
    /// Vault files written with an independent AES-256-GCM (Node's crypto) in the formats
    /// Nexo reads: version 2 with its AAD, a version 1 entry, and the previous engine's file.
    /// They pin the format: any change of cipher must still read them.
    const VERSION_2_FILE: &str = r#"{"version":2,"secrets":{"api":{"v":2,"iv":"010101010101010101010101","tag":"f07845919842c7bb1fc1630b302af730","data":"ca43e2177693e8928ddd7fbb84e3f576"},"legacy":{"iv":"020202020202020202020202","tag":"06eaa808e2cf8ab5a66b793cf01a7b56","data":"9c6689197e34a1"}}}"#;
    const NODE_ENGINE_FILE: &str = r#"{"old":{"iv":"030303030303030303030303","tag":"fc9e13fb5407b4123d1d507e6af677e5","data":"a6e6820621d9058cb9db8f3b835cb7"}}"#;

    #[tokio::test]
    async fn reads_the_pinned_vault_files() {
        for (file, name, value) in [
            (VERSION_2_FILE, "api", "s3cret ✓ value"),
            (VERSION_2_FILE, "legacy", "from v1"),
            (NODE_ENGINE_FILE, "old", "written by Node"),
        ] {
            let dir = directory();
            std::fs::create_dir_all(&dir).unwrap();
            std::fs::write(owner_file(&dir, "local"), file).unwrap();
            let vault = Vault::new(dir.clone(), [9; 32], "local");
            assert_eq!(vault.get(name).await.unwrap(), value, "{name}");
            // The AAD binds version 2 entries to their owner.
            let other = Vault::new(dir.clone(), [9; 32], "other");
            std::fs::copy(owner_file(&dir, "local"), owner_file(&dir, "other")).unwrap();
            assert_eq!(other.get(name).await.is_ok(), name != "api", "{name}");
            let _ = std::fs::remove_dir_all(dir);
        }
    }

    #[tokio::test]
    async fn reads_files_written_by_the_previous_engine() {
        // Written by the JavaScript engine: version 1 entries without AAD, upgraded on write.
        let dir = directory();
        let vault = Vault::new(dir.clone(), [9; 32], "local");
        std::fs::write(owner_file(&dir, "local"), NODE_ENGINE_FILE).unwrap();
        assert_eq!(vault.get("old").await.unwrap(), "written by Node");
        vault.put("new", "x").await.unwrap();
        let file: Value =
            serde_json::from_str(&std::fs::read_to_string(owner_file(&dir, "local")).unwrap())
                .unwrap();
        assert_eq!(file["version"], 2);
        assert_eq!(file["secrets"]["old"]["v"], 2);
        assert_eq!(vault.get("old").await.unwrap(), "written by Node");
        let rotated = vault.rotate([4; 32]).await.unwrap();
        assert_eq!(rotated.get("old").await.unwrap(), "written by Node");
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
