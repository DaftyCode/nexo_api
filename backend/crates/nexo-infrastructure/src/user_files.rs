//! The user's own files a database connection may read, only when it says so (DB-25):
//! PostgreSQL's password file, where libpq looks for it. `PGPASSFILE` names another one, as
//! for libpq; `NEXO_PGPASS` too, for tests. A connection never chooses the path. On Unix a
//! file others can read is refused, as libpq ignores it.
use async_trait::async_trait;
use nexo_application::ports::UserFiles;
use nexo_domain::{Error, Result};
use std::path::PathBuf;

/// A larger file is not a password file.
const MAX_SIZE: u64 = 1024 * 1024;

#[derive(Default)]
pub struct HomeFiles;

/// Where this user's pgpass file is: `~/.pgpass`, or `%APPDATA%\postgresql\pgpass.conf`.
fn pgpass_path() -> Option<PathBuf> {
    for variable in ["NEXO_PGPASS", "PGPASSFILE"] {
        if let Some(path) = std::env::var_os(variable).filter(|path| !path.is_empty()) {
            return Some(PathBuf::from(path));
        }
    }
    if cfg!(windows) {
        let data = std::env::var_os("APPDATA")?;
        Some(PathBuf::from(data).join("postgresql").join("pgpass.conf"))
    } else {
        Some(std::env::home_dir()?.join(".pgpass"))
    }
}

#[async_trait]
impl UserFiles for HomeFiles {
    async fn pgpass(&self) -> Result<Option<String>> {
        let Some(path) = pgpass_path() else {
            return Ok(None);
        };
        tokio::task::spawn_blocking(move || read(&path))
            .await
            .map_err(|error| Error::Infrastructure(error.to_string()))?
    }
}

fn read(path: &std::path::Path) -> Result<Option<String>> {
    let Ok(metadata) = std::fs::metadata(path) else {
        return Ok(None);
    };
    if !metadata.is_file() || metadata.len() > MAX_SIZE {
        return Ok(None);
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if metadata.permissions().mode() & 0o077 != 0 {
            return Err(Error::Validation(format!(
                "{} can be read by other users: allow only yours (chmod 0600)",
                path.display()
            )));
        }
    }
    std::fs::read_to_string(path)
        .map(Some)
        .map_err(|error| Error::Infrastructure(format!("The pgpass file cannot be read: {error}")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_missing_or_huge_file_is_no_file_and_a_small_one_is_read() {
        let folder = std::env::temp_dir().join(format!("nexo-pgpass-{}", std::process::id()));
        std::fs::create_dir_all(&folder).unwrap();
        let file = folder.join("pgpass");
        assert_eq!(read(&file).unwrap(), None);
        std::fs::write(&file, "h:5432:d:u:pw\n").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o644)).unwrap();
            assert!(read(&file).unwrap_err().to_string().contains("chmod 0600"));
            std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o600)).unwrap();
        }
        assert_eq!(read(&file).unwrap().as_deref(), Some("h:5432:d:u:pw\n"));
        assert_eq!(read(&folder).unwrap(), None);
        std::fs::remove_dir_all(&folder).unwrap();
    }
}
