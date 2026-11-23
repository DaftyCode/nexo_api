//! The archives of llama.cpp opened into the engine's folder: zip on Windows, tar.gz on Linux
//! and macOS. No entry may land outside the folder.
use nexo_domain::{Error, Result};
use std::{
    fs::File,
    io::BufReader,
    path::{Path, PathBuf},
};

fn failed(reason: impl std::fmt::Display) -> Error {
    Error::Infrastructure(format!(
        "The engine of the local model could not be unpacked: {reason}"
    ))
}

/// Opens `archive` into `folder`.
pub(crate) fn unpack(archive: &Path, folder: &Path) -> Result<()> {
    std::fs::create_dir_all(folder).map_err(failed)?;
    let name = archive.to_string_lossy().to_ascii_lowercase();
    let file = File::open(archive).map_err(failed)?;
    if name.ends_with(".zip") {
        let mut zip = zip::ZipArchive::new(BufReader::new(file)).map_err(failed)?;
        for index in 0..zip.len() {
            let mut entry = zip.by_index(index).map_err(failed)?;
            // A name that climbs out of the folder, or is absolute, is refused.
            let Some(relative) = entry.enclosed_name() else {
                let name = entry
                    .name()
                    .map(|name| name.into_owned())
                    .unwrap_or_default();
                return Err(failed(format!("{name} is outside the archive")));
            };
            let path = folder.join(relative);
            if entry.is_dir() {
                std::fs::create_dir_all(&path).map_err(failed)?;
                continue;
            }
            if let Some(parent) = path.parent() {
                std::fs::create_dir_all(parent).map_err(failed)?;
            }
            let mut out = File::create(&path).map_err(failed)?;
            std::io::copy(&mut entry, &mut out).map_err(failed)?;
            #[cfg(unix)]
            if let Some(mode) = entry.unix_mode() {
                use std::os::unix::fs::PermissionsExt;
                std::fs::set_permissions(&path, std::fs::Permissions::from_mode(mode & 0o755))
                    .map_err(failed)?;
            }
        }
        Ok(())
    } else if name.ends_with(".tar.gz") || name.ends_with(".tgz") {
        let mut tar = tar::Archive::new(flate2::read::GzDecoder::new(BufReader::new(file)));
        tar.set_preserve_permissions(true);
        for entry in tar.entries().map_err(failed)? {
            let mut entry = entry.map_err(failed)?;
            // `unpack_in` refuses an entry whose path leaves the folder.
            if !entry.unpack_in(folder).map_err(failed)? {
                let path = entry.path().map_err(failed)?.display().to_string();
                return Err(failed(format!("{path} is outside the archive")));
            }
        }
        Ok(())
    } else {
        Err(failed("not a zip or tar.gz archive"))
    }
}

/// The `llama-server` executable inside an engine's folder, at any depth.
pub(crate) fn server_in(folder: &Path) -> Option<PathBuf> {
    let wanted = format!("llama-server{}", std::env::consts::EXE_SUFFIX);
    let mut pending = vec![folder.to_path_buf()];
    while let Some(next) = pending.pop() {
        for entry in std::fs::read_dir(&next).ok()?.flatten() {
            let path = entry.path();
            if path.is_dir() {
                pending.push(path);
            } else if path.file_name().is_some_and(|name| name == wanted.as_str()) {
                return Some(path);
            }
        }
    }
    None
}
