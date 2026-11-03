use crate::infrastructure as err;
use async_trait::async_trait;
use nexo_application::ports::VersionControl;
use nexo_domain::{Actor, Error, Result};
use serde_json::{Value, json};
use std::path::PathBuf;
use tokio::process::Command;

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
        || !value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        Err(Error::Validation("Invalid project identifier".into()))
    } else {
        Ok(value)
    }
}
#[async_trait]
impl VersionControl for GitAdapter {
    async fn execute(&self, actor: &Actor, operation: &str, payload: Value) -> Result<Value> {
        let workspace = segment(payload["workspace"].as_str().unwrap_or("local"))?;
        let directory = self.root.join(segment(&actor.id)?).join(workspace);
        tokio::fs::create_dir_all(&directory).await.map_err(err)?;
        if operation == "export" {
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
        let mut args: Vec<String> = match operation {
            "init" => vec!["init".into()],
            "status" => vec!["status".into(), "--porcelain=v2".into(), "--branch".into()],
            "diff" => vec!["diff".into(), "--no-ext-diff".into(), "--".into()],
            "log" => vec!["log".into(), "-30".into(), "--oneline".into()],
            "branches" => vec!["branch".into(), "--list".into()],
            "stash" => vec!["stash".into(), "push".into(), "--include-untracked".into()],
            "checkout" | "branch" => {
                let branch = payload["branch"].as_str().unwrap_or("");
                if branch.is_empty()
                    || branch.starts_with('-')
                    || branch.len() > 200
                    || branch.contains("..")
                    || branch.contains(char::is_whitespace)
                {
                    return Err(Error::Validation("Invalid branch name".into()));
                }
                vec![
                    if operation == "checkout" {
                        "switch".into()
                    } else {
                        "branch".into()
                    },
                    branch.into(),
                ]
            }
            "commit" => vec![
                "-c".into(),
                "user.name=Nexo API".into(),
                "-c".into(),
                "user.email=nexo@localhost".into(),
                "commit".into(),
                "-m".into(),
                payload["message"]
                    .as_str()
                    .filter(|x| !x.is_empty())
                    .unwrap_or("Update API workspace")
                    .into(),
            ],
            _ => return Err(Error::Validation("Unsupported Git operation".into())),
        };
        if operation == "commit" {
            let status = Command::new("git")
                .arg("-C")
                .arg(&directory)
                .args(["add", "--all", "--", "."])
                .status()
                .await
                .map_err(err)?;
            if !status.success() {
                return Err(Error::Validation("Git add failed".into()));
            }
        }
        let mut command = Command::new("git");
        command
            .arg("-C")
            .arg(&directory)
            .args(args.drain(..))
            .kill_on_drop(true);
        #[cfg(windows)]
        command.creation_flags(0x08000000);
        let output = tokio::time::timeout(std::time::Duration::from_secs(15), command.output())
            .await
            .map_err(err)?
            .map_err(err)?;
        Ok(
            json!({"success":output.status.success(),"stdout":String::from_utf8_lossy(&output.stdout),"stderr":String::from_utf8_lossy(&output.stderr)}),
        )
    }
}
