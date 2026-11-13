//! Checking a module's files against the manifest and writing them where Nexo runs them.
use super::{ModuleStore, failed};
use crate::catalog::{ModuleEntry, executable_name};
use aws_lc_rs::digest::{SHA256, digest};
use nexo_domain::{Error, Result};
use std::{
    fs,
    io::{Read, Write},
    path::Path,
};

/// The SHA-256 of `bytes`, in lowercase hexadecimal, as the manifest writes it.
pub(crate) fn sha256(bytes: &[u8]) -> String {
    digest(&SHA256, bytes)
        .as_ref()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

/// The driver inside a release asset, when the asset and the driver are what the manifest
/// says: the compressed size and hash, then the uncompressed ones. Never decompresses more
/// than the manifest's size, so a crafted file cannot fill the disk or the memory.
pub(crate) fn unpack(entry: &ModuleEntry, compressed: &[u8]) -> Result<Vec<u8>> {
    if compressed.len() as u64 != entry.compressed_size
        || sha256(compressed) != entry.compressed_sha256
    {
        return Err(Error::Validation(format!(
            "The {} module file is not the one this version of Nexo expects; it was not installed",
            entry.name
        )));
    }
    let mut driver = Vec::with_capacity(entry.size as usize);
    flate2::read::GzDecoder::new(compressed)
        .take(entry.size + 1)
        .read_to_end(&mut driver)
        .map_err(|error| {
            Error::Validation(format!(
                "The {} module file is damaged: {error}",
                entry.name
            ))
        })?;
    check(entry, &driver)?;
    Ok(driver)
}

/// Whether `driver` is the driver the manifest names.
pub(crate) fn check(entry: &ModuleEntry, driver: &[u8]) -> Result<()> {
    if driver.len() as u64 != entry.size || sha256(driver) != entry.sha256 {
        return Err(Error::Validation(format!(
            "The {} driver is not the one this version of Nexo expects; it was not installed",
            entry.name
        )));
    }
    Ok(())
}

/// Writes `file` whole or not at all: a partial file in the same directory, flushed to disk,
/// then renamed over the old one.
fn write_atomically(file: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let directory = file.parent().unwrap_or(Path::new("."));
    let name = file
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("driver");
    let partial = directory.join(format!(".{name}.partial-{}", uuid::Uuid::new_v4().simple()));
    let written = (|| {
        let mut output = fs::File::create(&partial)?;
        output.write_all(bytes)?;
        output.sync_all()?;
        drop(output);
        // Only its owner may run, change or read it.
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&partial, fs::Permissions::from_mode(0o700))?;
        }
        fs::rename(&partial, file)
    })();
    if written.is_err() {
        let _ = fs::remove_file(&partial);
    }
    written
}

impl ModuleStore {
    /// Installs a checked driver for this version of Nexo and deletes the other versions.
    /// Its process must not be running: on Windows a running executable cannot be replaced.
    pub fn commit(&self, entry: &ModuleEntry, driver: &[u8]) -> Result<()> {
        check(entry, driver)?;
        let directory = self.version_dir(&entry.id);
        fs::create_dir_all(&directory)
            .and_then(|()| write_atomically(&directory.join(executable_name(&entry.id)), driver))
            .map_err(|error| failed(&entry.name, error))?;
        self.remove_other_versions(&entry.id);
        tracing::info!(target: "nexo::modules", module = %entry.id, version = %entry.version, "Module installed");
        Ok(())
    }

    /// Deletes the module of `id`: every version, and what a failed installation left.
    pub fn remove_files(&self, id: &str) -> Result<()> {
        let directory = self.config.root.join(id);
        match fs::remove_dir_all(&directory) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(failed(id, error)),
        }
    }

    fn remove_other_versions(&self, id: &str) {
        let current = &self.config.manifest.version;
        let Ok(versions) = fs::read_dir(self.config.root.join(id)) else {
            return;
        };
        for version in versions.flatten() {
            if version.file_name().to_str() != Some(current.as_str()) {
                let _ = fs::remove_dir_all(version.path());
            }
        }
        // Partial files of an installation that stopped half way.
        let Ok(files) = fs::read_dir(self.version_dir(id)) else {
            return;
        };
        for file in files.flatten() {
            if file.file_name().to_string_lossy().contains(".partial-") {
                let _ = fs::remove_file(file.path());
            }
        }
    }

    /// The installed driver of `id`, checked against the manifest before it runs. A driver
    /// that changed on disk is deleted, so it is never run.
    pub(super) fn verified(&self, entry: &ModuleEntry) -> Result<Option<std::path::PathBuf>> {
        let path = self.version_dir(&entry.id).join(executable_name(&entry.id));
        let driver = match fs::read(&path) {
            Ok(driver) => driver,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(failed(&entry.name, error)),
        };
        if check(entry, &driver).is_err() {
            let _ = fs::remove_file(&path);
            tracing::warn!(target: "nexo::modules", module = %entry.id, "An installed driver changed on disk and was deleted");
            return Err(Error::Validation(format!(
                "The {} driver changed on disk and was deleted; install the module again",
                entry.name
            )));
        }
        Ok(Some(path))
    }
}
