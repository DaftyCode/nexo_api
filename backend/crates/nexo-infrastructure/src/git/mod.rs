//! Git projects of the workspaces: the system `git`, confined to one directory per workspace,
//! and its remotes over HTTPS and SSH.
//!
//! Nexo never stores Git credentials. Network operations use the person's credential helper
//! (Git Credential Manager on Windows) and SSH agent; nothing else of their Git configuration
//! is loaded.

mod command;
mod remote;
mod sync;

use crate::infrastructure as err;
use async_trait::async_trait;
#[cfg(test)]
use command::network_failure;
use command::{
    base, credential_helpers, git, helper_args, network_result, output_json, run, run_for,
};
use nexo_application::{
    operations::GitOperation,
    ports::{NetworkPolicy, VersionControl},
};
use nexo_domain::{Error, Result, WorkspaceId};
#[cfg(test)]
use remote::Destination;
use remote::remote_url;
use serde_json::{Value, json};
use std::{path::Path, path::PathBuf, sync::Arc, time::Duration};
use tokio::process::Command;

const TIMEOUT: Duration = Duration::from_secs(15);
/// Fetch, pull, push and clone: long enough for a credential manager sign-in.
const NETWORK_TIMEOUT: Duration = Duration::from_secs(180);
/// What `files` reads back from a project.
const MAX_FILES: usize = 1000;
const MAX_FILE: u64 = 20 * 1024 * 1024;

pub struct GitAdapter {
    root: PathBuf,
    network: Arc<dyn NetworkPolicy>,
    /// `GIT_ALLOW_PROTOCOL`: HTTPS and SSH; tests add `file` for local bare repositories.
    protocols: &'static str,
}
impl GitAdapter {
    pub fn new(root: PathBuf, network: Arc<dyn NetworkPolicy>) -> Self {
        Self {
            root,
            network,
            protocols: "https:ssh",
        }
    }
    /// Lets tests use `file://` remotes; the application never does.
    #[cfg(test)]
    fn with_local_remotes(mut self) -> Self {
        self.protocols = "https:ssh:file";
        self
    }
    fn allows_files(&self) -> bool {
        self.protocols.ends_with(":file")
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
/// A branch or remote name: never an option, a range or a path outside the refs.
fn reference<'a>(value: &'a str, what: &str) -> Result<&'a str> {
    if value.is_empty()
        || value.starts_with('-')
        || value.len() > 200
        || value.contains("..")
        || value.chars().any(|c| c.is_whitespace() || c.is_control())
    {
        Err(Error::Validation(format!("Invalid {what} name")))
    } else {
        Ok(value)
    }
}
fn remote_name(payload: &Value) -> Result<&str> {
    let name = reference(payload["remote"].as_str().unwrap_or("origin"), "remote")?;
    if name
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || "-_./".contains(c))
    {
        Ok(name)
    } else {
        Err(Error::Validation("Invalid remote name".into()))
    }
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
        match operation {
            GitOperation::Export => {
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
            GitOperation::Clone => return self.clone(&directory, &payload).await,
            _ => {}
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
                let branch = reference(payload["branch"].as_str().unwrap_or(""), "branch")?;
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
            GitOperation::Files => return Self::files(&directory),
            GitOperation::RemoteList => return self.remotes(&directory).await,
            GitOperation::RemoteAdd => {
                let name = remote_name(&payload)?;
                let url = payload["url"].as_str().unwrap_or("").trim();
                remote_url(url, self.allows_files())?;
                vec![
                    "remote".into(),
                    "add".into(),
                    "--".into(),
                    name.into(),
                    url.into(),
                ]
            }
            GitOperation::RemoteRemove => vec![
                "remote".into(),
                "remove".into(),
                "--".into(),
                remote_name(&payload)?.into(),
            ],
            GitOperation::Fetch => {
                let remote = remote_name(&payload)?;
                self.check_remote(&directory, remote).await?;
                let output = self
                    .network(&directory, &["fetch", "--prune", remote])
                    .await?;
                return network_result(output);
            }
            GitOperation::Pull => return self.pull(&directory, &payload).await,
            GitOperation::Push => {
                let remote = remote_name(&payload)?;
                self.check_remote(&directory, remote).await?;
                let mut args = vec!["push", "--set-upstream"];
                if payload["forceWithLease"].as_bool().unwrap_or(false) {
                    args.push("--force-with-lease");
                }
                args.extend([remote, "HEAD"]);
                let output = self.network(&directory, &args).await?;
                return network_result(output);
            }
            GitOperation::Export | GitOperation::Clone => unreachable!("handled above"),
        };
        if operation == GitOperation::Commit {
            let mut add = git(&directory, self.protocols);
            add.args(["add", "--all", "--", "."]);
            let output = run(add).await?;
            if !output.status.success() {
                return Err(Error::Validation(format!(
                    "Git add failed: {}",
                    String::from_utf8_lossy(&output.stderr).trim()
                )));
            }
        }
        let mut command = git(&directory, self.protocols);
        command.args(args);
        let output = run(command).await?;
        Ok(output_json(&output))
    }
}

#[cfg(test)]
mod tests;
