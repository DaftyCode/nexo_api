//! A run of a tool: its process, the lines it writes (redacted, the last ones kept), how it
//! ended, and its private temporary folder, deleted when it ends.
use std::{
    collections::VecDeque,
    path::PathBuf,
    sync::Mutex,
    time::{Duration, Instant},
};
use tokio::{
    io::{AsyncBufReadExt, AsyncRead, BufReader},
    process::Child,
    sync::Notify,
};

/// Lines kept of a run; older ones are counted, not kept.
const LINES: usize = 2000;
/// Characters kept of a line.
const LINE: usize = 2000;

pub(super) struct Job {
    pub tool: String,
    started: Instant,
    secrets: Vec<String>,
    state: Mutex<State>,
    pub cancel: Notify,
}

struct State {
    status: &'static str,
    lines: VecDeque<String>,
    dropped: u64,
    exit_code: Option<i32>,
    seconds: Option<f64>,
}

impl Job {
    pub fn new(tool: &str, secrets: Vec<String>) -> Self {
        Self {
            tool: tool.to_string(),
            started: Instant::now(),
            // Short values would hide too much of the output and say little.
            secrets: secrets
                .into_iter()
                .filter(|secret| secret.len() >= 3)
                .collect(),
            state: Mutex::new(State {
                status: "running",
                lines: VecDeque::new(),
                dropped: 0,
                exit_code: None,
                seconds: None,
            }),
            cancel: Notify::new(),
        }
    }

    pub fn running(&self) -> bool {
        self.state.lock().unwrap().status == "running"
    }

    /// A line of the tool, without the secrets of the run.
    pub fn push(&self, line: &str) {
        let mut line: String = line.chars().take(LINE).collect();
        for secret in &self.secrets {
            line = line.replace(secret.as_str(), "****");
        }
        let mut state = self.state.lock().unwrap();
        if state.lines.len() >= LINES {
            state.lines.pop_front();
            state.dropped += 1;
        }
        state.lines.push_back(line);
    }

    pub fn finish(&self, status: &'static str, exit_code: Option<i32>) {
        let mut state = self.state.lock().unwrap();
        state.status = status;
        state.exit_code = exit_code;
        state.seconds = Some(self.started.elapsed().as_secs_f64());
    }

    pub fn status(&self) -> serde_json::Value {
        let state = self.state.lock().unwrap();
        serde_json::json!({
            "tool": self.tool,
            "state": state.status,
            "lines": state.lines,
            "dropped": state.dropped,
            "exitCode": state.exit_code,
            "seconds": state.seconds.unwrap_or_else(|| self.started.elapsed().as_secs_f64()),
        })
    }
}

/// Copies the lines of a stream of the process into the job.
pub(super) async fn follow(job: &Job, stream: impl AsyncRead + Unpin) {
    let mut lines = BufReader::new(stream).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        job.push(&line);
    }
}

enum Ended {
    Exited(std::io::Result<std::process::ExitStatus>),
    Cancelled,
    TimedOut,
}

/// Waits for the process, its cancellation or its time limit; then deletes `temp`.
pub(super) async fn wait(job: &Job, mut child: Child, limit: Option<Duration>, temp: PathBuf) {
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let streams = async {
        tokio::join!(
            async {
                if let Some(out) = stdout {
                    follow(job, out).await;
                }
            },
            async {
                if let Some(err) = stderr {
                    follow(job, err).await;
                }
            }
        );
    };
    let deadline = async {
        match limit {
            Some(limit) => tokio::time::sleep(limit).await,
            None => std::future::pending().await,
        }
    };
    let ended = tokio::select! {
        (_, status) = async { tokio::join!(streams, child.wait()) } => Ended::Exited(status),
        _ = job.cancel.notified() => Ended::Cancelled,
        _ = deadline => Ended::TimedOut,
    };
    // The private folder goes before the run says it ended: nothing of it is left then.
    let (status, code) = match ended {
        Ended::Exited(Ok(status)) if status.success() => ("finished", status.code()),
        Ended::Exited(Ok(status)) => ("failed", status.code()),
        Ended::Exited(Err(error)) => {
            job.push(&format!("The tool could not be followed: {error}"));
            ("failed", None)
        }
        Ended::Cancelled => {
            let _ = child.kill().await;
            ("cancelled", None)
        }
        Ended::TimedOut => {
            let _ = child.kill().await;
            job.push("Stopped: it took longer than its time limit");
            ("failed", None)
        }
    };
    let _ = std::fs::remove_dir_all(&temp);
    job.finish(status, code);
}
