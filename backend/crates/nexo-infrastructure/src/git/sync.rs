//! Branches, remotes, pull, clone and the files of the workspace project.
use super::*;

impl GitAdapter {
    pub(super) async fn current_branch(&self, directory: &Path) -> Result<String> {
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
    pub(super) async fn remotes(&self, directory: &Path) -> Result<Value> {
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
    pub(super) async fn pull(&self, directory: &Path, payload: &Value) -> Result<Value> {
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
    pub(super) async fn clone(&self, directory: &Path, payload: &Value) -> Result<Value> {
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
    pub(super) fn files(directory: &Path) -> Result<Value> {
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
