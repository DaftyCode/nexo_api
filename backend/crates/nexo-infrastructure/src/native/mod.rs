//! The local client tools of the databases, run as programs of the person's computer (DB-23).
//!
//! A tool runs without a shell, as the executable of its exact name in the folder found for
//! it, with the arguments and environment the domain built. None of the person's `PG…` or
//! `MYSQL…` variables reach it. The files it reads its connection from live in a private
//! temporary folder of its own, deleted when it ends; the files it backs up to or restores
//! from are never in Nexo's data folder. Its output is kept redacted, and a run can be
//! cancelled, which ends its process.
mod job;
mod locate;

#[cfg(test)]
mod tests;

use crate::infrastructure as err;
use async_trait::async_trait;
use job::Job;
use nexo_application::ports::{LocatedTool, NativeJob, NativeTools, NetworkPolicy};
use nexo_domain::{
    Error, Result,
    native::{TEMP, Tool},
};
use serde_json::Value;
use std::{
    path::{Path, PathBuf},
    process::Stdio,
    sync::{Arc, Mutex},
};
use tokio::process::Command;

/// Runs kept to follow, the newest; older finished ones are forgotten.
const KEPT: usize = 20;
/// Runs at once.
const RUNNING: usize = 4;

pub struct NativeAdapter {
    network: Arc<dyn NetworkPolicy>,
    /// Nexo's own data: no tool reads or writes there.
    protected: Vec<PathBuf>,
    jobs: Mutex<Vec<(String, Arc<Job>)>>,
}

/// Leaves out of a command every variable of the person's environment that the clients read
/// to connect (`PGPASSWORD`, `PGSERVICEFILE`, `MYSQL_PWD`…).
pub(super) fn clean_environment(command: &mut Command) {
    for (name, _) in std::env::vars_os() {
        let upper = name.to_string_lossy().to_ascii_uppercase();
        if upper.starts_with("PG") || upper.starts_with("MYSQL") || upper.starts_with("MARIADB") {
            command.env_remove(&name);
        }
    }
    #[cfg(windows)]
    command.creation_flags(0x08000000);
}

/// `text` with the private folder of the run in place of [`TEMP`]. Its path is written with
/// `/`, which every client reads on every system and which the MySQL options file does not
/// take for an escape.
fn placed(text: &str, temp: &Path) -> String {
    text.replace(TEMP, &temp.display().to_string().replace('\\', "/"))
}

/// Whether a path is inside one of `protected`, once both are whole and real (a file not
/// made yet is checked by its folder).
fn inside(path: &Path, protected: &[PathBuf]) -> bool {
    let real = path
        .canonicalize()
        .or_else(|_| {
            let parent = path.parent().unwrap_or(path).canonicalize()?;
            Ok::<_, std::io::Error>(parent.join(path.file_name().unwrap_or_default()))
        })
        .unwrap_or_else(|_| path.to_path_buf());
    protected.iter().any(|folder| {
        let folder = folder.canonicalize().unwrap_or_else(|_| folder.clone());
        real.starts_with(&folder)
    })
}

/// A new private folder for the files of a run: only the person reads it.
fn private_folder() -> Result<PathBuf> {
    let folder =
        std::env::temp_dir().join(format!("nexo-native-{}", uuid::Uuid::new_v4().simple()));
    std::fs::create_dir(&folder).map_err(err)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&folder, std::fs::Permissions::from_mode(0o700)).map_err(err)?;
    }
    Ok(folder)
}

fn write_private(path: &Path, content: &str) -> Result<()> {
    #[cfg(unix)]
    {
        use std::{io::Write, os::unix::fs::OpenOptionsExt};
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(path)
            .map_err(err)?;
        file.write_all(content.as_bytes()).map_err(err)
    }
    #[cfg(not(unix))]
    std::fs::write(path, content).map_err(err)
}

impl NativeAdapter {
    pub fn new(network: Arc<dyn NetworkPolicy>, protected: Vec<PathBuf>) -> Self {
        Self {
            network,
            protected,
            jobs: Mutex::new(Vec::new()),
        }
    }

    fn job(&self, id: &str) -> Result<Arc<Job>> {
        self.jobs
            .lock()
            .unwrap()
            .iter()
            .find(|(known, _)| known == id)
            .map(|(_, job)| job.clone())
            .ok_or_else(|| Error::Validation("That run is no longer kept".into()))
    }

    /// The command of a run, its private folder made and its files written.
    fn command(&self, tool: &LocatedTool, job: &NativeJob, temp: &Path) -> Result<Command> {
        for path in &job.paths {
            if inside(Path::new(path), &self.protected) {
                return Err(Error::Validation(
                    "Choose a file outside Nexo's own data folder".into(),
                ));
            }
        }
        let invocation = &job.invocation;
        for (name, content) in &invocation.files {
            if name.contains(['/', '\\']) || name.starts_with('.') {
                return Err(err("A temporary file of a run has a plain name"));
            }
            write_private(&temp.join(name), &placed(content, temp))?;
        }
        let mut command = Command::new(&tool.path);
        clean_environment(&mut command);
        command
            .args(invocation.args.iter().map(|arg| placed(arg, temp)))
            .envs(
                invocation
                    .env
                    .iter()
                    .map(|(key, value)| (key, placed(value, temp))),
            )
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        match &invocation.stdin {
            Some(path) => {
                let file = std::fs::File::open(path).map_err(|error| {
                    Error::Validation(format!("The file {path} cannot be read: {error}"))
                })?;
                command.stdin(Stdio::from(file));
            }
            None => {
                command.stdin(Stdio::null());
            }
        }
        Ok(command)
    }
}

#[async_trait]
impl NativeTools for NativeAdapter {
    async fn locate(&self, folder: Option<&str>, tools: &[Tool]) -> Result<LocatedTool> {
        let (tool, path) = locate::find(folder, tools)?;
        let version = locate::version(&path).await?;
        Ok(LocatedTool {
            tool,
            path: path.display().to_string(),
            version,
        })
    }

    async fn destination(&self, host: &str, port: u16) -> Result<Option<String>> {
        if self.network.restrictive() {
            let addresses = self.network.resolve_destination(host, port).await?;
            let address = addresses
                .first()
                .ok_or_else(|| Error::Validation(format!("{host} has no address")))?;
            return Ok(Some(address.ip().to_string()));
        }
        self.network.check_destination(host, port).await?;
        Ok(None)
    }

    async fn start(&self, tool: &LocatedTool, job: NativeJob) -> Result<String> {
        let running = self
            .jobs
            .lock()
            .unwrap()
            .iter()
            .filter(|(_, job)| job.running())
            .count();
        if running >= RUNNING {
            return Err(Error::Validation(format!(
                "{RUNNING} local client runs are going on: wait for one to end"
            )));
        }
        // What runs is the tool of that exact name, and nothing else.
        if Path::new(&tool.path)
            .file_stem()
            .and_then(|stem| stem.to_str())
            != Some(tool.tool.name())
        {
            return Err(err("The tool found is not the one asked for"));
        }
        let temp = private_folder()?;
        let child = match self.command(tool, &job, &temp).and_then(|mut command| {
            command.spawn().map_err(|error| {
                Error::Validation(format!("{} cannot run: {error}", tool.tool.name()))
            })
        }) {
            Ok(child) => child,
            Err(error) => {
                let _ = std::fs::remove_dir_all(&temp);
                return Err(error);
            }
        };
        let id = uuid::Uuid::new_v4().to_string();
        let run = Arc::new(Job::new(tool.tool.name(), job.secrets));
        {
            let mut jobs = self.jobs.lock().unwrap();
            jobs.push((id.clone(), run.clone()));
            while jobs.len() > KEPT {
                match jobs.iter().position(|(_, job)| !job.running()) {
                    Some(oldest) => jobs.remove(oldest),
                    None => break,
                };
            }
        }
        let timeout = job.timeout;
        tokio::spawn(async move { job::wait(&run, child, timeout, temp).await });
        Ok(id)
    }

    async fn status(&self, id: &str) -> Result<Value> {
        Ok(self.job(id)?.status())
    }

    async fn cancel(&self, id: &str) -> Result<()> {
        let job = self.job(id)?;
        if job.running() {
            job.cancel.notify_one();
        }
        Ok(())
    }
}
