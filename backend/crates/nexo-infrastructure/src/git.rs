//! Git projects of the workspaces: the system `git`, confined to one directory per workspace,
//! and its remotes over HTTPS and SSH.
//!
//! Nexo never stores Git credentials. Network operations use the person's credential helper
//! (Git Credential Manager on Windows) and SSH agent; nothing else of their Git configuration
//! is loaded.
use crate::infrastructure as err;
use async_trait::async_trait;
use nexo_application::{
    operations::GitOperation,
    ports::{NetworkPolicy, VersionControl},
};
use nexo_domain::{Error, Result, WorkspaceId};
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

/// Where a remote is, for the egress policy.
#[derive(Debug, PartialEq, Eq)]
struct Destination {
    host: String,
    port: u16,
}

/// Checks a remote URL: `https://`, `ssh://` or `user@host:path`. Transport helpers
/// (`ext::`), local paths and anything that Git could read as an option are refused.
/// Returns where it connects; `None` for a `file://` remote, which only tests allow.
fn remote_url(url: &str, allow_files: bool) -> Result<Option<Destination>> {
    let refuse = |why: &str| Err(Error::Validation(why.into()));
    let only = "Use an https:// or ssh:// address, or user@host:path";
    if url.is_empty() {
        return refuse("The remote needs a URL");
    }
    if url.len() > 2048
        || url.starts_with('-')
        || url.chars().any(|c| c.is_whitespace() || c.is_control())
    {
        return refuse(only);
    }
    // `<transport>::<address>` runs a remote helper, such as `ext::sh -c …`.
    if let Some((transport, _)) = url.split_once("::")
        && !transport.is_empty()
        && transport
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "+.-".contains(c))
    {
        return refuse(only);
    }
    if let Some((scheme, _)) = url.split_once("://") {
        let scheme = scheme.to_ascii_lowercase();
        if scheme == "file" && allow_files {
            return Ok(None);
        }
        let port = match scheme.as_str() {
            "https" => 443,
            "ssh" => 22,
            _ => return refuse(only),
        };
        let parsed = url::Url::parse(url).map_err(|_| Error::Validation(only.into()))?;
        if parsed.password().is_some() {
            return refuse(
                "Remove the password from the URL: Git asks your credential manager for it",
            );
        }
        let host = parsed
            .host_str()
            .filter(|host| !host.is_empty())
            .ok_or_else(|| Error::Validation(only.into()))?;
        return Ok(Some(Destination {
            host: host.trim_matches(['[', ']']).to_string(),
            port: parsed.port().unwrap_or(port),
        }));
    }
    // The scp-like form, `user@host:path`.
    let Some((user, rest)) = url.split_once('@') else {
        return refuse(only);
    };
    let Some((host, path)) = rest.split_once(':') else {
        return refuse(only);
    };
    let valid_host = !host.is_empty()
        && !host.starts_with(['-', '.'])
        && host
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-');
    if user.is_empty() || user.contains(['/', ':']) || !valid_host || path.is_empty() {
        return refuse(only);
    }
    Ok(Some(Destination {
        host: host.to_ascii_lowercase(),
        port: 22,
    }))
}

/// Git with nothing of the person's configuration: no hooks, helpers or filesystem monitors
/// configured elsewhere run, and only HTTPS and SSH reach the network.
fn base(protocols: &str) -> Command {
    let mut command = Command::new("git");
    command
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env(
            "GIT_CONFIG_GLOBAL",
            if cfg!(windows) { "NUL" } else { "/dev/null" },
        )
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_ALLOW_PROTOCOL", protocols)
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
            "-c",
            "submodule.recurse=false",
        ])
        .stdin(std::process::Stdio::null())
        .kill_on_drop(true);
    // SSH never asks in a console that nobody sees; the agent still signs in.
    if std::env::var_os("GIT_SSH_COMMAND").is_none() && std::env::var_os("GIT_SSH").is_none() {
        command.env("GIT_SSH_COMMAND", "ssh -o BatchMode=yes");
    }
    #[cfg(windows)]
    command.creation_flags(0x08000000);
    command
}
/// A Git command confined to one project directory.
///
/// `GIT_DIR`/`GIT_WORK_TREE` stop Git from discovering a repository in a parent directory
/// (for example the Nexo source tree during development or a versioned home directory).
fn git(directory: &Path, protocols: &str) -> Command {
    let mut command = base(protocols);
    command
        .current_dir(directory)
        .env("GIT_DIR", directory.join(".git"))
        .env("GIT_WORK_TREE", directory)
        .env(
            "GIT_CEILING_DIRECTORIES",
            directory.parent().unwrap_or(directory),
        );
    command
}
async fn run_for(mut command: Command, limit: Duration) -> Result<std::process::Output> {
    tokio::time::timeout(limit, command.output())
        .await
        .map_err(|_| {
            Error::Validation(format!(
                "Git did not finish within {} seconds",
                limit.as_secs()
            ))
        })?
        .map_err(|error| {
            if error.kind() == std::io::ErrorKind::NotFound {
                Error::Validation("Git is not installed or not on PATH".into())
            } else {
                err(error)
            }
        })
}
async fn run(command: Command) -> Result<std::process::Output> {
    run_for(command, TIMEOUT).await
}

/// The person's credential helpers, from the system and global configuration in that order;
/// an empty value clears the earlier ones, as in Git. Nothing else of that configuration is
/// read.
async fn credential_helpers() -> Vec<String> {
    let mut helpers = Vec::new();
    for scope in ["--system", "--global"] {
        let mut command = Command::new("git");
        command
            .args(["config", scope, "--get-all", "credential.helper"])
            .stdin(std::process::Stdio::null())
            .kill_on_drop(true);
        #[cfg(windows)]
        command.creation_flags(0x08000000);
        let Ok(Ok(output)) = tokio::time::timeout(TIMEOUT, command.output()).await else {
            continue;
        };
        for line in String::from_utf8_lossy(&output.stdout).lines() {
            if line.trim().is_empty() {
                helpers.clear();
            } else {
                helpers.push(line.trim().to_string());
            }
        }
    }
    helpers
}
/// `-c` arguments that use only those helpers.
fn helper_args(helpers: &[String]) -> Vec<String> {
    let mut args = vec!["-c".to_string(), "credential.helper=".to_string()];
    for helper in helpers {
        args.push("-c".into());
        args.push(format!("credential.helper={helper}"));
    }
    args
}

/// What failed in a network operation, said so the person knows what to do.
fn network_failure(stderr: &str) -> Option<&'static str> {
    let text = stderr.to_ascii_lowercase();
    if [
        "authentication failed",
        "could not read username",
        "could not read password",
        "terminal prompts disabled",
        "permission denied (publickey",
        "invalid username or password",
        "access denied",
        "http basic",
    ]
    .iter()
    .any(|pattern| text.contains(pattern))
    {
        Some(
            "Git could not sign in to the remote. Set up your Git credentials: Git Credential Manager for HTTPS, or an SSH key loaded in your SSH agent.",
        )
    } else if text.contains("host key verification failed") {
        Some(
            "The SSH host is not trusted yet. Connect once with ssh from a terminal to add it to known_hosts, then try again.",
        )
    } else if text.contains("not possible to fast-forward")
        || text.contains("diverging branches")
        || text.contains("have diverged")
    {
        Some(
            "Your branch and the remote have different commits. Pull with rebase, or push your branch with force with lease if yours should win. Nothing was changed.",
        )
    } else if text.contains("stale info") {
        Some(
            "The remote branch changed since your last fetch. Fetch, check the changes, and push again. Nothing was changed on the remote.",
        )
    } else if text.contains("[rejected]") || text.contains("non-fast-forward") {
        Some(
            "The remote has commits that your branch does not. Pull first, then push. Nothing was changed on the remote.",
        )
    } else if text.contains("would be overwritten") {
        Some("Commit or stash your changes before pulling. Nothing was changed.")
    } else {
        None
    }
}
fn output_json(output: &std::process::Output) -> Value {
    json!({
        "success": output.status.success(),
        "stdout": String::from_utf8_lossy(&output.stdout),
        "stderr": String::from_utf8_lossy(&output.stderr)
    })
}
/// A failed network operation as an error that says what to do, with Git's own words.
fn network_result(output: std::process::Output) -> Result<Value> {
    if output.status.success() {
        return Ok(output_json(&output));
    }
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    match network_failure(&stderr) {
        Some(advice) => Err(Error::Validation(format!("{advice}\n\n{stderr}"))),
        None => Ok(output_json(&output)),
    }
}

impl GitAdapter {
    async fn check_url(&self, url: &str) -> Result<()> {
        if let Some(destination) = remote_url(url, self.allows_files())? {
            self.network
                .check_destination(&destination.host, destination.port)
                .await?;
        }
        Ok(())
    }
    /// The URL of a remote, checked again before Git connects to it.
    async fn check_remote(&self, directory: &Path, remote: &str) -> Result<()> {
        let mut command = git(directory, self.protocols);
        command.args(["remote", "get-url", "--", remote]);
        let output = run(command).await?;
        if !output.status.success() {
            return Err(Error::Validation(format!(
                "There is no remote named {remote}. Add it first."
            )));
        }
        self.check_url(String::from_utf8_lossy(&output.stdout).trim())
            .await
    }
    /// A network command, with the person's credential helpers.
    async fn network(&self, directory: &Path, args: &[&str]) -> Result<std::process::Output> {
        let mut command = git(directory, self.protocols);
        command
            .args(helper_args(&credential_helpers().await))
            .args(args);
        run_for(command, NETWORK_TIMEOUT).await
    }
    async fn current_branch(&self, directory: &Path) -> Result<String> {
        let mut command = git(directory, self.protocols);
        command.args(["symbolic-ref", "--quiet", "--short", "HEAD"]);
        let output = run(command).await?;
        let branch = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if !output.status.success() || branch.is_empty() {
            return Err(Error::Validation(
                "Switch to a branch first: this project is not on one".into(),
            ));
        }
        Ok(branch)
    }
    async fn remotes(&self, directory: &Path) -> Result<Value> {
        let mut command = git(directory, self.protocols);
        command.args(["remote", "-v"]);
        let output = run(command).await?;
        let mut remotes: Vec<Value> = Vec::new();
        for line in String::from_utf8_lossy(&output.stdout).lines() {
            let mut fields = line.split_whitespace();
            let (Some(name), Some(url)) = (fields.next(), fields.next()) else {
                continue;
            };
            if !remotes.iter().any(|remote| remote["name"] == name) {
                remotes.push(json!({"name": name, "url": url}));
            }
        }
        let mut result = output_json(&output);
        result["remotes"] = Value::Array(remotes);
        Ok(result)
    }
    /// Pulls the current branch: fast-forward only, or rebased on the remote. A pull that
    /// cannot finish is undone, so the project is never left half merged.
    async fn pull(&self, directory: &Path, payload: &Value) -> Result<Value> {
        let remote = remote_name(payload)?;
        self.check_remote(directory, remote).await?;
        let branch = self.current_branch(directory).await?;
        let mode = if payload["rebase"].as_bool().unwrap_or(false) {
            "--rebase"
        } else {
            "--ff-only"
        };
        let output = self
            .network(
                directory,
                &["pull", mode, "--no-autostash", "--no-edit", remote, &branch],
            )
            .await?;
        if !output.status.success() {
            let git_dir = directory.join(".git");
            let abort =
                if git_dir.join("rebase-merge").exists() || git_dir.join("rebase-apply").exists() {
                    Some("rebase")
                } else if git_dir.join("MERGE_HEAD").exists() {
                    Some("merge")
                } else {
                    None
                };
            if let Some(operation) = abort {
                let mut command = git(directory, self.protocols);
                command.args([operation, "--abort"]);
                run(command).await?;
                return Err(Error::Validation(format!(
                    "Your changes and the remote's change the same lines, so the pull stopped and was undone. Nothing was changed.\n\n{}",
                    String::from_utf8_lossy(&output.stderr).trim()
                )));
            }
        }
        network_result(output)
    }
    /// Clones into the empty project of a new workspace.
    async fn clone(&self, directory: &Path, payload: &Value) -> Result<Value> {
        let url = payload["url"].as_str().unwrap_or("").trim();
        remote_url(url, self.allows_files())?;
        let empty = std::fs::read_dir(directory).map_err(err)?.next().is_none();
        if !empty {
            return Err(Error::Validation(
                "This workspace already has a project. Clone into a new workspace.".into(),
            ));
        }
        self.check_url(url).await?;
        let mut command = base(self.protocols);
        command
            .current_dir(directory)
            .args(helper_args(&credential_helpers().await))
            .args(["clone", "--no-recurse-submodules", "--", url, "."]);
        let output = run_for(command, NETWORK_TIMEOUT).await?;
        if !output.status.success() {
            // An empty project again, so the clone can be tried once more.
            if let Ok(entries) = std::fs::read_dir(directory) {
                for entry in entries.flatten() {
                    let path = entry.path();
                    let _ = if path.is_dir() {
                        std::fs::remove_dir_all(path)
                    } else {
                        std::fs::remove_file(path)
                    };
                }
            }
        }
        network_result(output)
    }
    /// The collections of the project, as `export` writes them.
    fn files(directory: &Path) -> Result<Value> {
        let mut files = Vec::new();
        let mut entries: Vec<PathBuf> = std::fs::read_dir(directory)
            .map_err(err)?
            .flatten()
            .map(|entry| entry.path())
            .filter(|path| path.extension().is_some_and(|e| e == "json"))
            .collect();
        entries.sort();
        for path in entries {
            let Some(id) = path
                .file_stem()
                .and_then(|stem| stem.to_str())
                .filter(|stem| segment(stem).is_ok())
            else {
                continue;
            };
            if files.len() == MAX_FILES {
                return Err(Error::Validation(format!(
                    "The project has more than {MAX_FILES} collections"
                )));
            }
            let metadata = std::fs::metadata(&path).map_err(err)?;
            if !metadata.is_file() || metadata.len() > MAX_FILE {
                continue;
            }
            let Ok(value) = serde_json::from_slice::<Value>(&std::fs::read(&path).map_err(err)?)
            else {
                continue;
            };
            files.push(json!({"id": id, "value": value}));
        }
        Ok(json!({"files": files}))
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
mod tests {
    use super::*;
    use std::sync::Mutex;

    /// Records the destinations checked, and refuses `blocked.test`.
    #[derive(Default)]
    struct Policy {
        checked: Mutex<Vec<(String, u16)>>,
    }
    #[async_trait]
    impl NetworkPolicy for Policy {
        async fn check_destination(&self, host: &str, port: u16) -> Result<()> {
            self.checked.lock().unwrap().push((host.into(), port));
            if host == "blocked.test" {
                Err(Error::Validation(format!(
                    "Destination {host} is blocked by the egress policy"
                )))
            } else {
                Ok(())
            }
        }
    }

    async fn git_available() -> bool {
        Command::new("git")
            .arg("--version")
            .output()
            .await
            .is_ok_and(|output| output.status.success())
    }
    fn temporary() -> PathBuf {
        let directory = std::env::temp_dir().join(format!("nexo-git-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&directory).unwrap();
        directory
    }
    fn workspace(id: &str) -> WorkspaceId {
        WorkspaceId::parse(id).unwrap()
    }
    /// A `file://` URL Git accepts on every system.
    fn file_url(path: &Path) -> String {
        let path = path.to_string_lossy().replace('\\', "/");
        if path.starts_with('/') {
            format!("file://{path}")
        } else {
            format!("file:///{path}")
        }
    }
    fn plain_git(directory: &Path, args: &[&str]) {
        let status = std::process::Command::new("git")
            .args(args)
            .current_dir(directory)
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env(
                "GIT_CONFIG_GLOBAL",
                if cfg!(windows) { "NUL" } else { "/dev/null" },
            )
            .status()
            .unwrap();
        assert!(status.success(), "git {args:?}");
    }
    fn message_of(result: Result<Value>) -> String {
        match result {
            Err(Error::Validation(message)) => message,
            other => panic!("expected a validation error, got {other:?}"),
        }
    }

    #[test]
    fn remote_urls_are_https_ssh_or_scp_like() {
        let ok = |url: &str| remote_url(url, false).unwrap().unwrap();
        assert_eq!(
            ok("https://github.com/acme/api.git"),
            Destination {
                host: "github.com".into(),
                port: 443
            }
        );
        assert_eq!(ok("https://user@git.example.com:8443/x.git").port, 8443);
        assert_eq!(
            ok("ssh://git@[::1]:2222/x.git"),
            Destination {
                host: "::1".into(),
                port: 2222
            }
        );
        assert_eq!(
            ok("git@GitHub.com:acme/api.git"),
            Destination {
                host: "github.com".into(),
                port: 22
            }
        );
        for url in [
            "",
            "ext::sh -c touch% /tmp/pwned",
            "ext::sh",
            "fd::17",
            "--upload-pack=touch /tmp/pwned",
            "-oProxyCommand=calc",
            "git@-oProxyCommand=calc:x",
            "file:///etc/passwd",
            "http://example.com/x.git",
            "git://example.com/x.git",
            "/home/me/repo",
            "C:\\repos\\api",
            "C:/repos/api",
            "../repo",
            "example.com:acme/api.git",
            "git@example.com:",
            "https://user:secret@example.com/x.git",
            "https://example.com/a b.git",
            "https://example.com/x\n.git",
        ] {
            assert!(remote_url(url, false).is_err(), "{url}");
        }
        assert!(
            message_of(remote_url("https://u:p@example.com/x", false).map(|_| json!(null)))
                .contains("password")
        );
        assert_eq!(remote_url("file:///tmp/repo.git", true).unwrap(), None);
    }

    #[test]
    fn network_failures_say_what_to_do() {
        for stderr in [
            "fatal: Authentication failed for 'https://example.com/x.git/'",
            "fatal: could not read Username for 'https://example.com': terminal prompts disabled",
            "git@example.com: Permission denied (publickey).",
        ] {
            assert!(
                network_failure(stderr).unwrap().contains("credentials"),
                "{stderr}"
            );
        }
        assert!(
            network_failure("Host key verification failed.")
                .unwrap()
                .contains("known_hosts")
        );
        assert!(
            network_failure("fatal: Not possible to fast-forward, aborting.")
                .unwrap()
                .contains("rebase")
        );
        assert!(
            network_failure(" ! [rejected]        main -> main (fetch first)")
                .unwrap()
                .contains("Pull first")
        );
        assert!(
            network_failure(" ! [rejected] main -> main (stale info)")
                .unwrap()
                .contains("Fetch")
        );
        assert!(
            network_failure("error: failed to push some refs: stale info")
                .unwrap()
                .contains("Fetch")
        );
        assert!(
            network_failure(
                "error: Your local changes to the following files would be overwritten by merge"
            )
            .unwrap()
            .contains("stash")
        );
        assert_eq!(network_failure("fatal: something else"), None);
        assert_eq!(
            helper_args(&["manager".into()]),
            [
                "-c",
                "credential.helper=",
                "-c",
                "credential.helper=manager"
            ]
        );
    }

    #[tokio::test]
    async fn operations_never_reach_a_parent_repository() {
        if !git_available().await {
            return;
        }
        let parent = temporary();
        plain_git(&parent, &["init", "-q"]);
        std::fs::write(parent.join("work.txt"), "uncommitted").unwrap();
        let adapter = GitAdapter::new(
            parent.join(".nexo").join("projects"),
            Arc::new(Policy::default()),
        );
        let local = workspace("local");
        for operation in [
            GitOperation::Status,
            GitOperation::Stash,
            GitOperation::Commit,
            GitOperation::Log,
            GitOperation::Fetch,
            GitOperation::Push,
            GitOperation::RemoteList,
        ] {
            let result = adapter.execute(&local, operation, json!({})).await;
            assert!(
                message_of(result).contains("Initialize"),
                "{operation} must require init"
            );
        }
        assert_eq!(
            std::fs::read_to_string(parent.join("work.txt")).unwrap(),
            "uncommitted"
        );
        let initialized = adapter
            .execute(&local, GitOperation::Init, json!({}))
            .await
            .unwrap();
        assert_eq!(initialized["success"], true);
        let status = adapter
            .execute(&local, GitOperation::Status, json!({}))
            .await
            .unwrap();
        assert!(!status["stdout"].as_str().unwrap().contains("work.txt"));
        let _ = std::fs::remove_dir_all(parent);
    }

    #[tokio::test]
    async fn remotes_are_checked_before_git_connects() {
        if !git_available().await {
            return;
        }
        let root = temporary();
        let policy = Arc::new(Policy::default());
        let adapter = GitAdapter::new(root.clone(), policy.clone());
        let w = workspace("w1");
        adapter
            .execute(&w, GitOperation::Init, json!({}))
            .await
            .unwrap();
        for url in ["ext::sh -c id", "--upload-pack=id", "file:///tmp/x"] {
            assert!(
                adapter
                    .execute(&w, GitOperation::RemoteAdd, json!({"url": url}))
                    .await
                    .is_err(),
                "{url}"
            );
        }
        for remote in ["-x", "a b", "a..b"] {
            assert!(
                message_of(
                    adapter
                        .execute(
                            &w,
                            GitOperation::RemoteAdd,
                            json!({"remote": remote, "url": "https://example.com/x.git"})
                        )
                        .await
                )
                .contains("remote name")
            );
        }
        adapter
            .execute(
                &w,
                GitOperation::RemoteAdd,
                json!({"remote": "origin", "url": "https://blocked.test/x.git"}),
            )
            .await
            .unwrap();
        let listed = adapter
            .execute(&w, GitOperation::RemoteList, json!({}))
            .await
            .unwrap();
        assert_eq!(
            listed["remotes"],
            json!([{"name": "origin", "url": "https://blocked.test/x.git"}])
        );
        // The egress policy refuses it before Git runs.
        for operation in [GitOperation::Fetch, GitOperation::Push] {
            assert!(
                message_of(adapter.execute(&w, operation, json!({})).await)
                    .contains("egress policy")
            );
        }
        assert_eq!(
            policy.checked.lock().unwrap()[0],
            ("blocked.test".to_string(), 443)
        );
        assert!(
            message_of(
                adapter
                    .execute(&w, GitOperation::Fetch, json!({"remote": "upstream"}))
                    .await
            )
            .contains("no remote named upstream")
        );
        adapter
            .execute(&w, GitOperation::RemoteRemove, json!({"remote": "origin"}))
            .await
            .unwrap();
        let listed = adapter
            .execute(&w, GitOperation::RemoteList, json!({}))
            .await
            .unwrap();
        assert_eq!(listed["remotes"], json!([]));
        // A workspace with a project is not cloned over.
        assert!(
            message_of(
                adapter
                    .execute(
                        &w,
                        GitOperation::Clone,
                        json!({"url": "https://example.com/x.git"})
                    )
                    .await
            )
            .contains("new workspace")
        );
        assert!(
            adapter
                .execute(
                    &workspace("w2"),
                    GitOperation::Clone,
                    json!({"url": "https://blocked.test/x.git"})
                )
                .await
                .is_err()
        );
        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn clone_push_fetch_and_pull_with_a_bare_remote() {
        if !git_available().await {
            return;
        }
        let root = temporary();
        let bare = root.join("remote.git");
        std::fs::create_dir_all(&bare).unwrap();
        plain_git(&bare, &["init", "-q", "--bare", "--initial-branch=main"]);
        let url = file_url(&bare);
        let adapter = GitAdapter::new(root.join("projects"), Arc::new(Policy::default()))
            .with_local_remotes();
        let (first, second) = (workspace("first"), workspace("second"));
        let run = |w: &WorkspaceId, operation: GitOperation, payload: Value| {
            let (adapter, w) = (&adapter, w.clone());
            async move { adapter.execute(&w, operation, payload).await }
        };
        let export = |w: &WorkspaceId, value: Value| {
            run(
                w,
                GitOperation::Export,
                json!({"files": [{"id": "c1", "value": value}]}),
            )
        };

        // The first workspace pushes its collection, on a branch named as the remote's.
        run(&first, GitOperation::Init, json!({})).await.unwrap();
        let mut command = git(&adapter.root.join("local").join("first"), adapter.protocols);
        command.args(["symbolic-ref", "HEAD", "refs/heads/main"]);
        assert!(run_for(command, TIMEOUT).await.unwrap().status.success());
        run(&first, GitOperation::RemoteAdd, json!({"url": url}))
            .await
            .unwrap();
        export(&first, json!({"info": {"name": "Shop"}, "item": []}))
            .await
            .unwrap();
        run(&first, GitOperation::Commit, json!({"message": "Add shop"}))
            .await
            .unwrap();
        let pushed = run(&first, GitOperation::Push, json!({})).await.unwrap();
        assert_eq!(pushed["success"], true, "{pushed}");

        // A new workspace clones it and reads its collections back.
        let cloned = run(&second, GitOperation::Clone, json!({"url": url}))
            .await
            .unwrap();
        assert_eq!(cloned["success"], true, "{cloned}");
        let files = run(&second, GitOperation::Files, json!({})).await.unwrap();
        assert_eq!(
            files["files"],
            json!([{"id": "c1", "value": {"info": {"name": "Shop"}, "item": []}}])
        );
        let status = run(&second, GitOperation::Status, json!({})).await.unwrap();
        assert!(
            status["stdout"]
                .as_str()
                .unwrap()
                .contains("# branch.head main")
        );

        // The second pushes a change; the first fetches it, sees it behind, and pulls.
        export(&second, json!({"info": {"name": "Shop v2"}, "item": []}))
            .await
            .unwrap();
        run(&second, GitOperation::Commit, json!({"message": "Rename"}))
            .await
            .unwrap();
        assert_eq!(
            run(&second, GitOperation::Push, json!({})).await.unwrap()["success"],
            true
        );
        run(&first, GitOperation::Fetch, json!({})).await.unwrap();
        let status = run(&first, GitOperation::Status, json!({})).await.unwrap();
        assert!(
            status["stdout"]
                .as_str()
                .unwrap()
                .contains("# branch.ab +0 -1"),
            "{status}"
        );
        let pulled = run(&first, GitOperation::Pull, json!({})).await.unwrap();
        assert_eq!(pulled["success"], true, "{pulled}");
        let files = run(&first, GitOperation::Files, json!({})).await.unwrap();
        assert_eq!(files["files"][0]["value"]["info"]["name"], "Shop v2");

        // Both change the same line: a fast-forward pull and a push are refused, a rebase
        // pull stops on the conflict and is undone.
        export(&first, json!({"info": {"name": "First"}, "item": []}))
            .await
            .unwrap();
        run(&first, GitOperation::Commit, json!({})).await.unwrap();
        export(&second, json!({"info": {"name": "Second"}, "item": []}))
            .await
            .unwrap();
        run(&second, GitOperation::Commit, json!({})).await.unwrap();
        run(&second, GitOperation::Push, json!({})).await.unwrap();
        assert!(
            message_of(run(&first, GitOperation::Push, json!({})).await).contains("Pull first")
        );
        assert!(
            message_of(run(&first, GitOperation::Pull, json!({})).await)
                .contains("different commits")
        );
        assert!(
            message_of(run(&first, GitOperation::Pull, json!({"rebase": true})).await)
                .contains("undone")
        );
        let project = adapter.root.join("local").join("first");
        assert!(!project.join(".git").join("rebase-merge").exists());
        assert!(!project.join(".git").join("rebase-apply").exists());
        let files = run(&first, GitOperation::Files, json!({})).await.unwrap();
        assert_eq!(files["files"][0]["value"]["info"]["name"], "First");
        // Force with lease replaces the remote branch once it was fetched.
        run(&first, GitOperation::Fetch, json!({})).await.unwrap();
        let forced = run(&first, GitOperation::Push, json!({"forceWithLease": true}))
            .await
            .unwrap();
        assert_eq!(forced["success"], true, "{forced}");
        let _ = std::fs::remove_dir_all(root);
    }
}
