//! The files a module opens instead of a server (SQLite): only the one the person chose, by
//! its full path on this computer, and never one inside Nexo's own data folder.
use nexo_driver_sdk::{DriverError, Result, protocol::ConnectParams};
use std::path::{Component, Path, PathBuf, Prefix};

/// The modules whose connections name a file of the disk in `database`.
const FILE_MODULES: [&str; 1] = ["sqlite"];

/// A full path on this computer: not relative, not a network share, not a device.
fn local(path: &Path) -> bool {
    path.is_absolute()
        && match path.components().next() {
            Some(Component::Prefix(prefix)) => {
                matches!(prefix.kind(), Prefix::Disk(_) | Prefix::VerbatimDisk(_))
            }
            _ => true,
        }
}

/// The path as the system resolves it, links followed, even when the file does not exist
/// yet: its folder resolved and its name added.
fn resolved(path: &Path) -> Option<PathBuf> {
    if let Ok(found) = path.canonicalize() {
        return Some(found);
    }
    let folder = path.parent()?.canonicalize().ok()?;
    Some(folder.join(path.file_name()?))
}

/// Refuses a connection of a file module whose file is not one the person may open: the
/// driver then never sees it.
pub(super) fn check(module: &str, params: &ConnectParams, protected: &[PathBuf]) -> Result<()> {
    if !FILE_MODULES.contains(&module) {
        return Ok(());
    }
    let text = params
        .database
        .as_deref()
        .map(str::trim)
        .unwrap_or_default();
    if text.is_empty() {
        return Err(DriverError::invalid(
            "Choose the database file of the connection",
        ));
    }
    let path = Path::new(text);
    if !local(path) {
        return Err(DriverError::invalid(
            "The database file must be a full path on this computer, such as \
             C:\\data\\shop.db or /home/ana/shop.db",
        ));
    }
    let file = resolved(path).ok_or_else(|| {
        DriverError::invalid(format!("The folder of {} does not exist", path.display()))
    })?;
    for folder in protected {
        let folder = folder.canonicalize().unwrap_or_else(|_| folder.clone());
        if file.starts_with(&folder) {
            return Err(DriverError::permission(
                "Nexo does not open the files of its own data folder as a database",
            ));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use nexo_driver_sdk::ErrorCode;

    fn sqlite(path: &Path) -> ConnectParams {
        ConnectParams {
            connection: "c".into(),
            database: Some(path.display().to_string()),
            ..ConnectParams::default()
        }
    }

    #[test]
    fn a_sqlite_file_is_never_one_of_the_data_folder() {
        let root = std::env::temp_dir().join(format!("nexo-files-{}", uuid::Uuid::new_v4()));
        let data = root.join("data");
        std::fs::create_dir_all(data.join("projects")).unwrap();
        std::fs::write(data.join("nexo.sqlite"), b"").unwrap();
        let protected = [data.clone()];
        let refused = |path: &Path| check("sqlite", &sqlite(path), &protected).unwrap_err();
        // The store, a new file in a folder of it, and the same reached through `..`.
        for path in [
            data.join("nexo.sqlite"),
            data.join("projects").join("new.db"),
            data.join("projects").join("..").join("nexo.sqlite"),
        ] {
            assert_eq!(refused(&path).code, ErrorCode::Permission, "{path:?}");
        }
        // A file beside it is the person's, existing or about to be created.
        check("sqlite", &sqlite(&root.join("shop.db")), &protected).unwrap();
        // Relative paths, missing folders and other modules.
        assert_eq!(
            refused(Path::new("shop.db")).code,
            ErrorCode::Invalid,
            "relative"
        );
        assert!(
            refused(&root.join("missing").join("a.db"))
                .message
                .contains("does not exist")
        );
        let mut empty = sqlite(Path::new(""));
        empty.database = None;
        assert!(check("sqlite", &empty, &protected).is_err());
        check("postgres", &empty, &protected).unwrap();
        std::fs::remove_dir_all(root).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn network_shares_and_devices_are_not_files_of_this_computer() {
        for path in [
            r"\\server\share\shop.db",
            r"\\.\PhysicalDrive0",
            r"\\?\UNC\s\x\a.db",
        ] {
            let error = check("sqlite", &sqlite(Path::new(path)), &[]).unwrap_err();
            assert_eq!(error.code, ErrorCode::Invalid, "{path}");
        }
    }
}
