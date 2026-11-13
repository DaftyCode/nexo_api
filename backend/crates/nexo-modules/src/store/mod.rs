//! Where the modules live on this computer: `<data>/modules/<id>/<version>/`, one version
//! per module, the one of this Nexo. A driver runs only after its hash matches the manifest.
mod files;
#[cfg(test)]
mod tests;

pub(crate) use files::{sha256, unpack};

use crate::catalog::{Manifest, ModuleEntry, executable_name, valid_id};
use crate::host::Executables;
use nexo_application::ports::{ModuleState, ModuleSummary};
use nexo_domain::{Error, Result, hosts::AllowedHosts};
use reqwest::Url;
use std::{
    fs,
    path::{Path, PathBuf},
};

/// Where Nexo's releases publish the modules of a version.
const RELEASES: &str = "https://github.com/DaftyCode/nexo_api/releases/download/";
/// Where a download may come from or be redirected to (GitHub keeps release files on its
/// content servers).
const RELEASE_HOSTS: [&str; 2] = ["github.com", "*.githubusercontent.com"];

pub struct StoreConfig {
    /// `<data>/modules`.
    pub root: PathBuf,
    pub manifest: Manifest,
    /// The address the release assets of this version are under, ending in `/`.
    pub source: Url,
    /// The hosts a download may reach, its redirections included.
    pub hosts: AllowedHosts,
    /// Copies that come with Nexo: the `modules` folder of the portable package.
    pub bundled: Option<PathBuf>,
    /// Drivers built by Cargo, run as they are without a manifest.
    pub development: Option<PathBuf>,
}

impl StoreConfig {
    /// The modules of a released Nexo, kept under `data`.
    pub fn released(data: &Path) -> Self {
        let manifest = Manifest::embedded();
        let source = format!("{RELEASES}v{}/", manifest.version);
        let bundled = std::env::current_exe()
            .ok()
            .and_then(|executable| Some(executable.parent()?.join("modules")))
            .filter(|folder| folder.is_dir());
        Self {
            root: data.join("modules"),
            source: Url::parse(&source).expect("the releases address is valid"),
            hosts: AllowedHosts::stored(&RELEASE_HOSTS),
            manifest,
            bundled,
            development: None,
        }
    }

    /// [`StoreConfig::released`] with what a development build may take from its
    /// environment: drivers built by Cargo (`NEXO_MODULES_DIR`), and a manifest
    /// (`NEXO_MODULES_CATALOG`) with the address its files are under (`NEXO_MODULES_SOURCE`),
    /// for the tests. A release build ignores them: it runs only what it verified.
    pub fn from_env(data: &Path) -> Self {
        let mut config = Self::released(data);
        if !cfg!(debug_assertions) {
            return config;
        }
        let variable = |name| std::env::var_os(name).filter(|value| !value.is_empty());
        config.development = variable("NEXO_MODULES_DIR").map(PathBuf::from);
        if let Some(path) = variable("NEXO_MODULES_CATALOG") {
            let text = fs::read_to_string(&path).unwrap_or_default();
            let (version, target) = (
                config.manifest.version.clone(),
                config.manifest.target.clone(),
            );
            match Manifest::parse(&text, &version, &target) {
                Ok(manifest) => config.manifest = manifest,
                Err(error) => {
                    tracing::error!(target: "nexo::modules", %error, "NEXO_MODULES_CATALOG is not a manifest")
                }
            }
        }
        let source =
            variable("NEXO_MODULES_SOURCE").and_then(|source| Url::parse(source.to_str()?).ok());
        if let Some(source) = source {
            config.hosts = AllowedHosts::stored(&[source.host_str().unwrap_or_default()]);
            config.source = source;
        }
        config
    }
}

pub struct ModuleStore {
    config: StoreConfig,
}

/// A file of a module that could not be read or written.
pub(crate) fn failed(what: &str, error: std::io::Error) -> Error {
    Error::Infrastructure(format!("The {what} module could not be stored: {error}"))
}
fn not_installed(id: &str) -> Error {
    Error::Validation(format!("The {id} module is not installed"))
}

impl ModuleStore {
    pub fn new(config: StoreConfig) -> Self {
        Self { config }
    }
    pub fn manifest(&self) -> &Manifest {
        &self.config.manifest
    }
    pub fn hosts(&self) -> &AllowedHosts {
        &self.config.hosts
    }
    /// The entry of a module this version of Nexo can install.
    pub fn entry(&self, id: &str) -> Result<&ModuleEntry> {
        self.config.manifest.entry(id).ok_or_else(|| {
            Error::Validation(format!("There is no {id} module for this version of Nexo"))
        })
    }
    /// Where the release asset of a module is downloaded from.
    pub fn url(&self, entry: &ModuleEntry) -> Result<Url> {
        self.config
            .source
            .join(&entry.file)
            .map_err(|error| Error::Infrastructure(error.to_string()))
    }
    fn version_dir(&self, id: &str) -> PathBuf {
        self.config
            .root
            .join(id)
            .join(&self.config.manifest.version)
    }
    fn development_driver(&self, id: &str) -> Option<PathBuf> {
        let folder = self.config.development.as_ref()?;
        Some(folder.join(executable_name(id))).filter(|path| path.is_file())
    }
    /// The copy of a module that came with Nexo: its release asset or its driver.
    pub fn bundled(&self, entry: &ModuleEntry) -> Option<PathBuf> {
        let folder = self.config.bundled.as_ref()?;
        [entry.file.clone(), executable_name(&entry.id)]
            .into_iter()
            .map(|name| folder.join(name))
            .find(|path| path.is_file())
    }

    /// The driver inside a module file the person chose: the release asset or the driver
    /// itself, recognised by its hash among this version's modules.
    pub fn recognise(&self, content: &[u8]) -> Result<(&ModuleEntry, Vec<u8>)> {
        let hash = sha256(content);
        let modules = &self.config.manifest.modules;
        if let Some(entry) = modules.iter().find(|entry| entry.compressed_sha256 == hash) {
            return Ok((entry, unpack(entry, content)?));
        }
        if let Some(entry) = modules.iter().find(|entry| entry.sha256 == hash) {
            return Ok((entry, content.to_vec()));
        }
        Err(Error::Validation(format!(
            "This file is not a module of Nexo {} for this computer",
            self.config.manifest.version
        )))
    }
    /// Installs the copy of a module that came with Nexo.
    fn install_bundled(&self, entry: &ModuleEntry) -> Result<Option<PathBuf>> {
        let Some(path) = self.bundled(entry) else {
            return Ok(None);
        };
        let content = fs::read(&path).map_err(|error| failed(&entry.name, error))?;
        let (_, driver) = self.recognise(&content)?;
        self.commit(entry, &driver)?;
        self.verified(entry)
    }

    /// The driver to run for a module: a development build as it is; otherwise the installed
    /// one, checked again, or the copy that came with Nexo, installed first.
    pub fn executable_path(&self, id: &str) -> Result<PathBuf> {
        if !valid_id(id) {
            return Err(Error::Validation("Invalid module name".into()));
        }
        if let Some(path) = self.development_driver(id) {
            return Ok(path);
        }
        let entry = self
            .config
            .manifest
            .entry(id)
            .ok_or_else(|| not_installed(id))?;
        if let Some(path) = self.verified(entry)? {
            return Ok(path);
        }
        self.install_bundled(entry)?
            .ok_or_else(|| not_installed(id))
    }

    /// Every module of this version, and the development drivers, with their state here.
    pub fn summaries(&self) -> Vec<ModuleSummary> {
        let mut summaries: Vec<ModuleSummary> = self
            .config
            .manifest
            .modules
            .iter()
            .map(|entry| self.summary(entry))
            .collect();
        for id in self.development_ids() {
            if !summaries.iter().any(|summary| summary.id == id) {
                summaries.push(ModuleSummary {
                    name: id.clone(),
                    description: String::new(),
                    version: self.config.manifest.version.clone(),
                    state: ModuleState::Development,
                    download_size: 0,
                    size: 0,
                    licenses: Vec::new(),
                    source: String::new(),
                    bundled: false,
                    id,
                });
            }
        }
        summaries.sort_by_key(|summary| summary.name.to_lowercase());
        summaries
    }
    pub fn summary(&self, entry: &ModuleEntry) -> ModuleSummary {
        let installed = self.version_dir(&entry.id).join(executable_name(&entry.id));
        let state = if self.development_driver(&entry.id).is_some() {
            ModuleState::Development
        } else if installed.is_file() {
            ModuleState::Installed
        } else if self.config.root.join(&entry.id).is_dir() {
            ModuleState::Outdated
        } else {
            ModuleState::Available
        };
        ModuleSummary {
            id: entry.id.clone(),
            name: entry.name.clone(),
            description: entry.description.clone(),
            version: entry.version.clone(),
            state,
            download_size: entry.compressed_size,
            size: entry.size,
            licenses: entry.licenses.clone(),
            source: self.url(entry).map(String::from).unwrap_or_default(),
            bundled: self.bundled(entry).is_some(),
        }
    }
    /// The modules whose driver is in the development folder.
    fn development_ids(&self) -> Vec<String> {
        let Some(folder) = &self.config.development else {
            return Vec::new();
        };
        let Ok(files) = fs::read_dir(folder) else {
            return Vec::new();
        };
        files
            .flatten()
            .filter_map(|file| {
                let name = file.file_name().into_string().ok()?;
                let stem = name.strip_suffix(std::env::consts::EXE_SUFFIX)?;
                let id = stem.strip_prefix("nexo-driver-")?;
                (valid_id(id) && file.path().is_file()).then(|| id.to_owned())
            })
            .collect()
    }
    /// Whether the driver of `id` is a development build, which Nexo does not remove.
    pub fn is_development(&self, id: &str) -> bool {
        self.development_driver(id).is_some()
    }
}

impl Executables for ModuleStore {
    fn executable(&self, module: &str) -> nexo_driver_sdk::Result<PathBuf> {
        self.executable_path(module).map_err(|error| {
            let message = error.to_string();
            match error {
                Error::Validation(_) => nexo_driver_sdk::DriverError::unsupported(message),
                _ => nexo_driver_sdk::DriverError::internal(message),
            }
        })
    }
}
