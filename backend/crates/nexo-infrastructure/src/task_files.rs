//! The files saved database tasks write and read (DB-40), in the desktop app: absolute paths
//! the person wrote in the task, in a folder that exists, never inside Nexo's own data (its
//! database, vault or modules), however the path is written.
use async_trait::async_trait;
use nexo_application::ports::TaskFiles;
use nexo_domain::{Error, Result};
use std::{
    io::Write,
    path::{Path, PathBuf},
};

pub struct LocalTaskFiles {
    /// Folders no task may touch, as written; compared once resolved.
    protected: Vec<PathBuf>,
}

impl LocalTaskFiles {
    pub fn new(protected: Vec<PathBuf>) -> Self {
        Self { protected }
    }

    /// The path a task wrote, resolved: absolute, in a folder that exists and not protected.
    fn place(&self, path: &str) -> Result<PathBuf> {
        let refused = |why: &str| Error::Validation(format!("{why}: {path}"));
        let written = Path::new(path.trim());
        if !written.is_absolute() {
            return Err(refused("A task's file is an absolute path"));
        }
        let (Some(folder), Some(name)) = (written.parent(), written.file_name()) else {
            return Err(refused("A task's file names a file"));
        };
        let folder = folder
            .canonicalize()
            .map_err(|_| refused("The folder of a task's file does not exist"))?;
        let place = folder.join(name);
        let resolved = place.canonicalize().unwrap_or_else(|_| place.clone());
        for protected in &self.protected {
            let protected = protected
                .canonicalize()
                .unwrap_or_else(|_| protected.clone());
            if resolved.starts_with(&protected) || folder.starts_with(&protected) {
                return Err(refused("A task never touches Nexo's own data"));
            }
        }
        if resolved.is_dir() {
            return Err(refused("A task's file is a folder"));
        }
        Ok(resolved)
    }
}

async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> Result<T> + Send + 'static,
) -> Result<T> {
    tokio::task::spawn_blocking(work)
        .await
        .map_err(|error| Error::Infrastructure(error.to_string()))?
}

fn io(path: &Path) -> impl Fn(std::io::Error) -> Error + '_ {
    move |error| Error::Validation(format!("{}: {error}", path.display()))
}

#[async_trait]
impl TaskFiles for LocalTaskFiles {
    async fn create(&self, path: &str, overwrite: bool) -> Result<String> {
        let place = self.place(path)?;
        blocking(move || {
            let mut options = std::fs::OpenOptions::new();
            options.write(true);
            if overwrite {
                options.create(true).truncate(true);
            } else {
                options.create_new(true);
            }
            options.open(&place).map_err(|error| {
                if error.kind() == std::io::ErrorKind::AlreadyExists {
                    Error::Validation(format!(
                        "{} exists: let the task replace it, or put {{date}} in its name",
                        place.display()
                    ))
                } else {
                    io(&place)(error)
                }
            })?;
            Ok(place.display().to_string())
        })
        .await
    }

    async fn append(&self, path: &str, bytes: Vec<u8>) -> Result<()> {
        let place = self.place(path)?;
        blocking(move || {
            let mut file = std::fs::OpenOptions::new()
                .append(true)
                .open(&place)
                .map_err(io(&place))?;
            file.write_all(&bytes).map_err(io(&place))
        })
        .await
    }

    async fn read(&self, path: &str, limit: u64) -> Result<Vec<u8>> {
        let place = self.place(path)?;
        blocking(move || {
            let size = std::fs::metadata(&place).map_err(io(&place))?.len();
            if size > limit {
                return Err(Error::Validation(format!(
                    "{} is larger than a task reads ({} MB)",
                    place.display(),
                    limit / (1024 * 1024)
                )));
            }
            std::fs::read(&place).map_err(io(&place))
        })
        .await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn files_are_written_and_read_only_where_a_task_may() {
        let root = std::env::temp_dir().join(format!("nexo-task-files-{}", std::process::id()));
        let data = root.join("data");
        let out = root.join("out");
        std::fs::create_dir_all(&data).unwrap();
        std::fs::create_dir_all(&out).unwrap();
        let files = LocalTaskFiles::new(vec![data.clone()]);
        let file = out.join("a.csv").display().to_string();
        let written = files.create(&file, false).await.unwrap();
        files.append(&written, b"a,b\r\n".to_vec()).await.unwrap();
        files.append(&written, b"1,2\r\n".to_vec()).await.unwrap();
        assert_eq!(files.read(&file, 1024).await.unwrap(), b"a,b\r\n1,2\r\n");
        assert!(
            files
                .read(&file, 3)
                .await
                .unwrap_err()
                .to_string()
                .contains("larger")
        );
        // It exists: replaced only when the task says so.
        let exists = files.create(&file, false).await.unwrap_err().to_string();
        assert!(exists.contains("{date}"), "{exists}");
        files.create(&file, true).await.unwrap();
        assert_eq!(files.read(&file, 1024).await.unwrap(), b"");
        for refused in [
            "relative/a.csv".to_owned(),
            data.join("nexo.sqlite").display().to_string(),
            out.join("..")
                .join("data")
                .join("x.csv")
                .display()
                .to_string(),
            root.join("missing").join("x.csv").display().to_string(),
            out.display().to_string(),
        ] {
            assert!(files.create(&refused, true).await.is_err(), "{refused}");
            assert!(files.read(&refused, 10).await.is_err(), "{refused}");
        }
        std::fs::remove_dir_all(&root).unwrap();
    }
}
