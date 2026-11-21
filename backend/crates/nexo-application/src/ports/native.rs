//! The local client tools of the database engines (`pg_dump`, `mysql`…), run as programs of
//! the person's computer. Only the desktop app composes them; the web version has none.
use async_trait::async_trait;
use nexo_domain::{
    Result,
    native::{Invocation, Tool},
};
use serde_json::Value;
use std::time::Duration;

/// A tool found on the computer: which one, where, and the version it says it is.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LocatedTool {
    pub tool: Tool,
    /// The executable, as a whole path.
    pub path: String,
    /// The first line of `--version`.
    pub version: String,
}

/// A run of a tool: what it runs and what is never shown of it.
#[derive(Debug, Clone)]
pub struct NativeJob {
    pub invocation: Invocation,
    /// The files and folders of the person it reads or writes: never Nexo's own data.
    pub paths: Vec<String>,
    /// Values taken out of everything it writes (the password, vault values).
    pub secrets: Vec<String>,
    /// The longest it may run; none for large backups.
    pub timeout: Option<Duration>,
}

#[async_trait]
pub trait NativeTools: Send + Sync {
    /// The first of `tools` found in `folder` or, without one, in the usual places of each
    /// system and in `PATH`.
    async fn locate(&self, folder: Option<&str>, tools: &[Tool]) -> Result<LocatedTool>;
    /// Checks a server against the egress policy; the address the tool must use instead of
    /// the name when the policy is strict, so that what was checked is what it reaches.
    async fn destination(&self, host: &str, port: u16) -> Result<Option<String>>;
    /// Starts a run; its id, to follow it.
    async fn start(&self, tool: &LocatedTool, job: NativeJob) -> Result<String>;
    /// How a run goes: `{state, lines, exitCode}`, the lines already redacted.
    async fn status(&self, id: &str) -> Result<Value>;
    /// Stops a run, ending its process.
    async fn cancel(&self, id: &str) -> Result<()>;
}
