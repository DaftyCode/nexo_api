mod remotes;
mod repository;

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
