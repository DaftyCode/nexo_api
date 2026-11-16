//! The file a connection opens: only the one the person chose, by its full path, and only
//! when it is a file of this computer (never a folder, a device or a network share). The
//! host refuses as well anything inside Nexo's own data folder.
//!
//! A name is only a name: `file:` URIs are not read, so no setting comes in through it.
use nexo_driver_sdk::{DriverError, Result};
use rusqlite::OpenFlags;
use std::path::{Component, Path, PathBuf, Prefix};

/// The file to open and how.
pub(crate) struct Target {
    pub path: PathBuf,
    pub flags: OpenFlags,
}

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

/// The file of a connection: `database` is its path; `create` makes it when it is missing.
pub(crate) fn target(database: Option<&str>, create: bool, read_only: bool) -> Result<Target> {
    let text = database
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .ok_or_else(|| DriverError::invalid("Choose the database file of the connection"))?;
    let path = PathBuf::from(text);
    if !local(&path) {
        return Err(DriverError::invalid(
            "The database file must be a full path on this computer, such as \
             C:\\data\\shop.db or /home/ana/shop.db",
        ));
    }
    match std::fs::metadata(&path) {
        Ok(found) if found.is_file() => {}
        Ok(_) => {
            return Err(DriverError::invalid(format!(
                "{} is not a file",
                path.display()
            )));
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            if read_only || !create {
                return Err(DriverError::invalid(format!(
                    "{} does not exist. To make a new database, set create to true",
                    path.display()
                )));
            }
            if !path.parent().is_some_and(Path::is_dir) {
                return Err(DriverError::invalid(format!(
                    "The folder of {} does not exist",
                    path.display()
                )));
            }
        }
        Err(error) => {
            return Err(DriverError::invalid(format!("{}: {error}", path.display())));
        }
    }
    // One thread owns each connection: SQLite needs no mutex of its own.
    let mut flags = OpenFlags::SQLITE_OPEN_NO_MUTEX;
    flags |= if read_only {
        OpenFlags::SQLITE_OPEN_READ_ONLY
    } else {
        OpenFlags::SQLITE_OPEN_READ_WRITE
    };
    if create && !read_only {
        flags |= OpenFlags::SQLITE_OPEN_CREATE;
    }
    Ok(Target { path, flags })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn opens_only_a_file_by_its_full_path() {
        let folder = std::env::temp_dir();
        let missing = folder.join(format!("nexo-sqlite-missing-{}.db", std::process::id()));
        let missing = missing.to_str().unwrap();
        assert!(target(None, false, false).is_err());
        assert!(target(Some("shop.db"), true, false).is_err());
        assert!(target(Some(folder.to_str().unwrap()), false, false).is_err());
        let refused = target(Some(missing), false, false).err().unwrap();
        assert!(refused.message.contains("set create to true"), "{refused}");
        assert!(
            target(Some(missing), true, true).is_err(),
            "never created read-only"
        );
        let created = target(Some(missing), true, false).unwrap();
        assert!(created.flags.contains(OpenFlags::SQLITE_OPEN_CREATE));
        assert!(!created.flags.contains(OpenFlags::SQLITE_OPEN_URI));
    }
}
