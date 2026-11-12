//! Reading and writing the encrypted vault file: AES-256-GCM bound to its path and version.
use super::*;

impl Vault {
    pub(super) fn aad(&self, name: &str, hosts: &[String]) -> Vec<u8> {
        if hosts.is_empty() {
            format!("nexo-vault:v{VERSION}\0{}\0{name}", self.owner).into_bytes()
        } else {
            format!(
                "nexo-vault:v{RESTRICTED}\0{}\0{name}\0{}",
                self.owner,
                hosts.join("\n")
            )
            .into_bytes()
        }
    }
    pub(super) fn read(&self) -> Result<BTreeMap<String, Entry>> {
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
    pub(super) fn decrypt(&self, name: &str, entry: &Entry) -> Result<String> {
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
        let aad = match entry.v {
            None => Vec::new(),
            Some(VERSION) if entry.hosts.is_empty() => self.aad(name, &[]),
            Some(RESTRICTED) if !entry.hosts.is_empty() => self.aad(name, &entry.hosts),
            Some(_) => return Err(failure()),
        };
        let plain = self
            .key
            .open_in_place(nonce, Aad::from(aad), &mut data)
            .map_err(|_| failure())?;
        String::from_utf8(plain.to_vec()).map_err(|_| failure())
    }
    pub(super) fn encrypt(&self, name: &str, value: &str, hosts: &[String]) -> Result<Entry> {
        let iv: [u8; 12] = rand_bytes();
        let aad = self.aad(name, hosts);
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
            v: Some(if hosts.is_empty() {
                VERSION
            } else {
                RESTRICTED
            }),
            iv: hex::encode(iv),
            tag: hex::encode(tag),
            data: hex::encode(data),
            hosts: hosts.to_vec(),
        })
    }
    pub(super) fn write(&self, mut entries: BTreeMap<String, Entry>) -> Result<()> {
        // Upgrade legacy entries so every stored value is bound to its owner and name.
        let names: Vec<String> = entries.keys().cloned().collect();
        for name in names {
            if entries[&name].v.is_none()
                && let Ok(value) = self.decrypt(&name, &entries[&name])
            {
                let upgraded = self.encrypt(&name, &value, &[])?;
                entries.insert(name, upgraded);
            }
        }
        std::fs::create_dir_all(&self.directory).map_err(infrastructure)?;
        let body = serde_json::json!({"version": VERSION, "secrets": entries});
        write_atomic(&self.path(), body.to_string().as_bytes())
    }

    /// Stores a new value, new allowed hosts (empty allows every host) or both. Without a
    /// value the current one is kept, so the hosts can change without typing it again.
    pub async fn store(
        &self,
        name: &str,
        value: Option<&str>,
        hosts: Option<&[String]>,
    ) -> Result<()> {
        let name = validate_name(name)?;
        if value.is_some_and(|value| value.len() > 64 * 1024) {
            return Err(Error::Validation(
                "Secret values must be text up to 64 KB".into(),
            ));
        }
        let _guard = self.lock.lock().await;
        let mut entries = self.read()?;
        let current = entries.get(name);
        let value = match (value, current) {
            (Some(value), _) => value.to_string(),
            (None, Some(entry)) => self.decrypt(name, entry)?,
            (None, None) => return Err(Error::Validation(format!("Secret not found: {name}"))),
        };
        let hosts = match hosts {
            Some(hosts) => hosts.to_vec(),
            None => current.map(|entry| entry.hosts.clone()).unwrap_or_default(),
        };
        entries.insert(name.to_string(), self.encrypt(name, &value, &hosts)?);
        self.write(entries)
    }
}
