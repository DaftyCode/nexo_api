//! Where the local client tools are: the folder a connection names or, without one, the
//! usual folders of each system (the newest version first) and `PATH`; and the version each
//! one says it is.
use nexo_domain::{Error, Result, native::Tool};
use std::{
    path::{Path, PathBuf},
    process::Stdio,
    time::Duration,
};
use tokio::process::Command;

/// How long `--version` may take.
const VERSION_TIMEOUT: Duration = Duration::from_secs(10);

/// The file of a tool in a folder.
pub(super) fn executable(folder: &Path, tool: Tool) -> PathBuf {
    let name = if cfg!(windows) {
        format!("{}.exe", tool.name())
    } else {
        tool.name().to_string()
    };
    folder.join(name)
}

/// The subfolders of `parent` whose name starts with `prefix`, the highest version first,
/// each with `inner` appended (`PostgreSQL/18/bin`).
fn versions(parent: &Path, prefix: &str, inner: &str) -> Vec<PathBuf> {
    let mut found: Vec<(Vec<u64>, PathBuf)> = std::fs::read_dir(parent)
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|entry| {
            let name = entry.file_name().to_string_lossy().to_string();
            let rest = name.strip_prefix(prefix)?;
            let version = rest
                .split(|c: char| !c.is_ascii_digit())
                .filter_map(|part| part.parse().ok())
                .collect();
            Some((version, entry.path().join(inner)))
        })
        .collect();
    found.sort_by(|a, b| b.0.cmp(&a.0));
    found.into_iter().map(|(_, path)| path).collect()
}

/// The usual folders of the client tools on this system, then the folders of `PATH`.
pub(super) fn usual_folders() -> Vec<PathBuf> {
    let mut folders = Vec::new();
    if cfg!(windows) {
        for root in ["C:\\Program Files", "C:\\Program Files (x86)"] {
            let root = Path::new(root);
            folders.extend(versions(&root.join("PostgreSQL"), "", "bin"));
            folders.extend(versions(&root.join("MySQL"), "MySQL Server ", "bin"));
            folders.extend(versions(root, "MariaDB ", "bin"));
        }
    } else if cfg!(target_os = "macos") {
        for folder in [
            "/opt/homebrew/opt/libpq/bin",
            "/usr/local/opt/libpq/bin",
            "/opt/homebrew/opt/mysql-client/bin",
            "/usr/local/opt/mysql-client/bin",
            "/Applications/Postgres.app/Contents/Versions/latest/bin",
            "/opt/homebrew/bin",
            "/usr/local/bin",
        ] {
            folders.push(PathBuf::from(folder));
        }
    } else {
        folders.extend(versions(Path::new("/usr/lib/postgresql"), "", "bin"));
        folders.push(PathBuf::from("/usr/bin"));
        folders.push(PathBuf::from("/usr/local/bin"));
    }
    if let Some(path) = std::env::var_os("PATH") {
        folders.extend(std::env::split_paths(&path));
    }
    folders
}

/// The first line a tool writes for `--version`.
pub(super) async fn version(path: &Path) -> Result<String> {
    let mut command = Command::new(path);
    command
        .arg("--version")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    super::clean_environment(&mut command);
    let output = tokio::time::timeout(VERSION_TIMEOUT, command.output())
        .await
        .map_err(|_| Error::Validation(format!("{} did not say its version", path.display())))?
        .map_err(|error| Error::Validation(format!("{} cannot run: {error}", path.display())))?;
    let text = String::from_utf8_lossy(&output.stdout);
    let line = text.lines().next().unwrap_or_default().trim();
    if !output.status.success() || line.is_empty() {
        return Err(Error::Validation(format!(
            "{} did not say its version",
            path.display()
        )));
    }
    Ok(line.chars().take(200).collect())
}

/// The first of `tools` in `folder`, or in the usual folders without one.
pub(super) fn find(folder: Option<&str>, tools: &[Tool]) -> Result<(Tool, PathBuf)> {
    let names = || {
        tools
            .iter()
            .map(|tool| tool.name())
            .collect::<Vec<_>>()
            .join(" or ")
    };
    let folders = match folder {
        Some(folder) => {
            let folder = PathBuf::from(folder);
            if !folder.is_absolute() || !folder.is_dir() {
                return Err(Error::Validation(format!(
                    "The local client folder {} does not exist",
                    folder.display()
                )));
            }
            vec![folder]
        }
        None => usual_folders(),
    };
    for tool in tools {
        for folder in &folders {
            let path = executable(folder, *tool);
            if path.is_file() {
                return Ok((*tool, path));
            }
        }
    }
    Err(Error::Validation(match folder {
        Some(folder) => format!("{} is not in the local client folder {folder}", names()),
        None => format!(
            "{} was not found: install the client tools of the database or choose their folder in the connection's Local client",
            names()
        ),
    }))
}
