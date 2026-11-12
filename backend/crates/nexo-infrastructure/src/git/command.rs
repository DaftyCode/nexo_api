//! Running Git: a clean environment, the allowed protocols, the credential helpers, time
//! limits and what a network failure means.
use super::*;

/// Git with nothing of the person's configuration: no hooks, helpers or filesystem monitors
/// configured elsewhere run, and only HTTPS and SSH reach the network.
pub(super) fn base(protocols: &str) -> Command {
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
pub(super) fn git(directory: &Path, protocols: &str) -> Command {
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
pub(super) async fn run_for(mut command: Command, limit: Duration) -> Result<std::process::Output> {
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
pub(super) async fn run(command: Command) -> Result<std::process::Output> {
    run_for(command, TIMEOUT).await
}

/// The person's credential helpers, from the system and global configuration in that order;
/// an empty value clears the earlier ones, as in Git. Nothing else of that configuration is
/// read.
pub(super) async fn credential_helpers() -> Vec<String> {
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
pub(super) fn helper_args(helpers: &[String]) -> Vec<String> {
    let mut args = vec!["-c".to_string(), "credential.helper=".to_string()];
    for helper in helpers {
        args.push("-c".into());
        args.push(format!("credential.helper={helper}"));
    }
    args
}

/// What failed in a network operation, said so the person knows what to do.
pub(super) fn network_failure(stderr: &str) -> Option<&'static str> {
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
pub(super) fn output_json(output: &std::process::Output) -> Value {
    json!({
        "success": output.status.success(),
        "stdout": String::from_utf8_lossy(&output.stdout),
        "stderr": String::from_utf8_lossy(&output.stderr)
    })
}
/// A failed network operation as an error that says what to do, with Git's own words.
pub(super) fn network_result(output: std::process::Output) -> Result<Value> {
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
    /// A network command, with the person's credential helpers.
    pub(super) async fn network(
        &self,
        directory: &Path,
        args: &[&str],
    ) -> Result<std::process::Output> {
        let mut command = git(directory, self.protocols);
        command
            .args(helper_args(&credential_helpers().await))
            .args(args);
        run_for(command, NETWORK_TIMEOUT).await
    }
}
