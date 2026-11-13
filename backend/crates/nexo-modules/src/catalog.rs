//! The manifest of the modules: which drivers this version of Nexo can install on this
//! platform, and the hashes their files must have. It travels inside the app, so the trust in
//! a downloaded driver comes from the app itself, never from where it was downloaded.
use nexo_driver_sdk::PROTOCOL_VERSION;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Manifest {
    /// The version of Nexo the drivers were built with.
    pub version: String,
    /// The Rust target triple of the platform.
    pub target: String,
    pub modules: Vec<ModuleEntry>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ModuleEntry {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub description: String,
    pub version: String,
    pub protocol: u32,
    /// The release asset: the driver compressed with gzip.
    pub file: String,
    /// Bytes and SHA-256 (lowercase hexadecimal) of the driver.
    pub size: u64,
    pub sha256: String,
    /// Bytes and SHA-256 of the release asset.
    pub compressed_size: u64,
    pub compressed_sha256: String,
    /// The licenses of the code the driver contains.
    #[serde(default)]
    pub licenses: Vec<String>,
}

/// The executable of a module's driver.
pub fn executable_name(id: &str) -> String {
    format!("nexo-driver-{id}{}", std::env::consts::EXE_SUFFIX)
}

/// A module id: lowercase letters, digits and dashes, as in `nexo-driver-<id>`.
pub fn valid_id(id: &str) -> bool {
    (1..=32).contains(&id.len())
        && id
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
        && !id.starts_with('-')
}

fn hash(text: &str) -> bool {
    text.len() == 64
        && text
            .chars()
            .all(|c| c.is_ascii_digit() || ('a'..='f').contains(&c))
}

/// A file name without any directory.
fn plain_file(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 128
        && !name.starts_with('.')
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
}

impl Manifest {
    /// The manifest of this build (empty when it was built without one).
    pub fn embedded() -> Self {
        let text = include_str!(concat!(env!("OUT_DIR"), "/modules.json"));
        Self::parse(text, env!("CARGO_PKG_VERSION"), env!("NEXO_MODULES_TARGET")).unwrap_or_else(
            |error| {
                tracing::error!(target: "nexo::modules", %error, "The embedded module manifest is invalid");
                Self::empty()
            },
        )
    }
    /// No modules, for this version and platform.
    pub fn empty() -> Self {
        Self {
            version: env!("CARGO_PKG_VERSION").into(),
            target: env!("NEXO_MODULES_TARGET").into(),
            modules: Vec::new(),
        }
    }
    /// Reads a manifest and checks that it belongs to `version` of Nexo on `target` and that
    /// every entry can be trusted to name a file and the hashes it must have. An empty text
    /// is a manifest without modules.
    pub fn parse(text: &str, version: &str, target: &str) -> Result<Self, String> {
        if text.trim().is_empty() {
            return Ok(Self {
                version: version.into(),
                target: target.into(),
                modules: Vec::new(),
            });
        }
        let manifest: Self =
            serde_json::from_str(text).map_err(|error| format!("not a manifest: {error}"))?;
        if manifest.version != version {
            return Err(format!(
                "it is for Nexo {}, not {version}",
                manifest.version
            ));
        }
        if manifest.target != target {
            return Err(format!("it is for {}, not {target}", manifest.target));
        }
        for (index, entry) in manifest.modules.iter().enumerate() {
            let problem = if !valid_id(&entry.id) {
                Some("an invalid id")
            } else if manifest.modules[..index]
                .iter()
                .any(|other| other.id == entry.id)
            {
                Some("a repeated id")
            } else if entry.protocol != PROTOCOL_VERSION {
                Some("another version of the driver protocol")
            } else if !plain_file(&entry.file) {
                Some("an invalid file name")
            } else if !hash(&entry.sha256) || !hash(&entry.compressed_sha256) {
                Some("an invalid SHA-256")
            } else if entry.size == 0 || entry.compressed_size == 0 {
                Some("an empty file")
            } else {
                None
            };
            if let Some(problem) = problem {
                return Err(format!("the module {:?} has {problem}", entry.id));
            }
        }
        Ok(manifest)
    }
    pub fn entry(&self, id: &str) -> Option<&ModuleEntry> {
        self.modules.iter().find(|entry| entry.id == id)
    }
}
