use crate::infrastructure as err;
use async_trait::async_trait;
use nexo_application::{operations::GitOperation, ports::VersionControl};
use nexo_domain::{Error, Result, WorkspaceId};
use serde_json::{Value, json};
use std::{path::Path, path::PathBuf, time::Duration};
use tokio::process::Command;

const TIMEOUT: Duration = Duration::from_secs(15);

pub struct GitAdapter {
    root: PathBuf,
}
impl GitAdapter {
    pub fn new(root: PathBuf) -> Self {
        Self { root }
    }
}
fn segment(value: &str) -> Result<&str> {
    if value.is_empty()
        || value.len() > 160
        || !value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        Err(Error::Validation("Invalid project identifier".into()))
    } else {
        Ok(value)
    }
}
/// Commit messages are a single line without control characters.
fn message(payload: &Value) -> String {
    let text: String = payload["message"]
        .as_str()
        .unwrap_or("")
        .chars()
        .filter(|c| !c.is_control())
        .take(500)
        .collect();
    let text = text.trim();
    if text.is_empty() {
        "Update API workspace".into()
    } else {
        text.into()
    }
}
/// A Git command confined to one project directory.
///
/// `GIT_DIR`/`GIT_WORK_TREE` stop Git from discovering a repository in a parent directory
/// (for example the Nexo source tree during development or a versioned home directory), and
/// the user's global and system configuration is ignored so hooks, credential helpers and
/// filesystem monitors configured elsewhere never run.
fn git(directory: &Path) -> Command {
    let mut command = Command::new("git");
    command
        .current_dir(directory)
        .env("GIT_DIR", directory.join(".git"))
        .env("GIT_WORK_TREE", directory)
        .env(
            "GIT_CEILING_DIRECTORIES",
            directory.parent().unwrap_or(directory),
        )
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env(
            "GIT_CONFIG_GLOBAL",
            if cfg!(windows) { "NUL" } else { "/dev/null" },
        )
        .env("GIT_TERMINAL_PROMPT", "0")
        .args([
            "-c",
            "core.hooksPath=",
            "-c",
            "core.fsmonitor=false",
            "-c",
            "user.name=Nexo API",
            "-c",
            "user.email=nexo@localhost",
            "-c",
            "commit.gpgsign=false",
        ])
        .stdin(std::process::Stdio::null())
        .kill_on_drop(true);
    #[cfg(windows)]
    command.creation_flags(0x08000000);
    command
}
async fn run(mut command: Command) -> Result<std::process::Output> {
    tokio::time::timeout(TIMEOUT, command.output())
        .await
        .map_err(|_| Error::Validation("Git did not finish within 15 seconds".into()))?
        .map_err(|error| {
            if error.kind() == std::io::ErrorKind::NotFound {
                Error::Validation("Git is not installed or not on PATH".into())
            } else {
                err(error)
            }
        })
}
#[async_trait]
impl VersionControl for GitAdapter {
    async fn execute(
        &self,
        workspace: &WorkspaceId,
        operation: GitOperation,
        payload: Value,
    ) -> Result<Value> {
        // Projects keep the directory layout of earlier versions: <root>/local/<workspace>.
        let directory = self.root.join("local").join(segment(workspace.as_str())?);
        tokio::fs::create_dir_all(&directory).await.map_err(err)?;
        if operation == GitOperation::Export {
            for file in payload["files"]
                .as_array()
                .ok_or_else(|| Error::Validation("Files array required".into()))?
            {
                let name = segment(file["id"].as_str().unwrap_or(""))?;
                tokio::fs::write(
                    directory.join(format!("{name}.json")),
                    serde_json::to_vec_pretty(&file["value"]).map_err(err)?,
                )
                .await
                .map_err(err)?;
            }
            return Ok(json!({"saved":true}));
        }
        let initialized = directory.join(".git").is_dir();
        if operation != GitOperation::Init && !initialized {
            return Err(Error::Validation(
                "Initialize the repository first (Git → Init)".into(),
            ));
        }
        let args: Vec<String> = match operation {
            GitOperation::Init => vec!["init".into()],
            GitOperation::Status => {
                vec!["status".into(), "--porcelain=v2".into(), "--branch".into()]
            }
            GitOperation::Diff => vec!["diff".into(), "--no-ext-diff".into(), "--".into()],
            GitOperation::Log => vec!["log".into(), "-30".into(), "--oneline".into()],
            GitOperation::Branches => vec!["branch".into(), "--list".into()],
            GitOperation::Stash => {
                vec!["stash".into(), "push".into(), "--include-untracked".into()]
            }
            GitOperation::Checkout | GitOperation::Branch => {
                let branch = payload["branch"].as_str().unwrap_or("");
                if branch.is_empty()
                    || branch.starts_with('-')
                    || branch.len() > 200
                    || branch.contains("..")
                    || branch.chars().any(|c| c.is_whitespace() || c.is_control())
                {
                    return Err(Error::Validation("Invalid branch name".into()));
                }
                vec![
                    if operation == GitOperation::Checkout {
                        "switch".into()
                    } else {
                        "branch".into()
                    },
                    branch.into(),
                ]
            }
            GitOperation::Commit => vec!["commit".into(), "-m".into(), message(&payload)],
            GitOperation::Export => unreachable!("handled above"),
        };
        if operation == GitOperation::Commit {
            let mut add = git(&directory);
            add.args(["add", "--all", "--", "."]);
            let output = run(add).await?;
            if !output.status.success() {
                return Err(Error::Validation(format!(
                    "Git add failed: {}",
                    String::from_utf8_lossy(&output.stderr).trim()
                )));
            }
        }
        let mut command = git(&directory);
        command.args(args);
        let output = run(command).await?;
        Ok(json!({
            "success": output.status.success(),
            "stdout": String::from_utf8_lossy(&output.stdout),
            "stderr": String::from_utf8_lossy(&output.stderr)
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    async fn git_available() -> bool {
        Command::new("git")
            .arg("--version")
            .output()
            .await
            .is_ok_and(|output| output.status.success())
    }
    #[tokio::test]
    async fn operations_never_reach_a_parent_repository() {
        if !git_available().await {
            return;
        }
        let parent = std::env::temp_dir().join(format!("nexo-git-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&parent).unwrap();
        let init = std::process::Command::new("git")
            .args(["init", "-q"])
            .current_dir(&parent)
            .status()
            .unwrap();
        assert!(init.success());
        std::fs::write(parent.join("work.txt"), "uncommitted").unwrap();
        let adapter = GitAdapter::new(parent.join(".nexo").join("projects"));
        let workspace = WorkspaceId::parse("local").unwrap();
        for operation in [
            GitOperation::Status,
            GitOperation::Stash,
            GitOperation::Commit,
            GitOperation::Log,
        ] {
            let result = adapter.execute(&workspace, operation, json!({})).await;
            assert!(
                matches!(result, Err(Error::Validation(ref m)) if m.contains("Initialize")),
                "{operation} must require init"
            );
        }
        assert_eq!(
            std::fs::read_to_string(parent.join("work.txt")).unwrap(),
            "uncommitted"
        );
        let initialized = adapter
            .execute(&workspace, GitOperation::Init, json!({}))
            .await
            .unwrap();
        assert_eq!(initialized["success"], true);
        let status = adapter
            .execute(&workspace, GitOperation::Status, json!({}))
            .await
            .unwrap();
        assert!(!status["stdout"].as_str().unwrap().contains("work.txt"));
        let _ = std::fs::remove_dir_all(parent);
    }
}
