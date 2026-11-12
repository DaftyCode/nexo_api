//! A run in progress: its state, pauses and delays, what it has delivered and how it ended.
use super::*;

#[derive(Default)]
pub(super) struct JobState {
    pub(super) state: String,
    pub(super) results: Vec<Value>,
    pub(super) assertions: Vec<Value>,
    pub(super) logs: Vec<Value>,
    pub(super) error: Option<String>,
    pub(super) duration: u64,
    pub(super) environment: Value,
    pub(super) globals: Value,
    pub(super) collection_variables: Value,
    pub(super) finished_at: Option<Instant>,
}
pub struct Job {
    pub(super) id: String,
    pub(super) started: Instant,
    pub(super) started_at: u64,
    pub(super) state: Mutex<JobState>,
    pub(super) cancelled: Arc<AtomicBool>,
    /// Paused between requests; the request being sent finishes first.
    pub(super) paused: AtomicBool,
    /// Wakes a paused run when it is resumed or cancelled.
    pub(super) resumed: tokio::sync::Notify,
    pub(super) secrets: Vec<String>,
    pub(super) done: tokio::sync::Notify,
}
impl Job {
    pub fn id(&self) -> &str {
        &self.id
    }
    #[cfg(test)]
    pub(super) fn done_state_settled(&self) -> bool {
        self.state
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .duration
            > 0
    }
    /// Running or paused: not finished yet.
    pub(super) fn running(&self) -> bool {
        matches!(
            self.state
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .state
                .as_str(),
            "running" | "paused"
        )
    }
    pub(super) fn set_state(&self, state: &str) {
        self.state.lock().unwrap_or_else(|e| e.into_inner()).state = state.into();
    }
    /// Waits while the run is paused, and returns how long it waited. A cancelled run stops.
    pub(super) async fn wait_while_paused(&self) -> Result<Duration> {
        let started = Instant::now();
        loop {
            // Registered before checking, so a resume between the check and the wait is seen.
            let resumed = self.resumed.notified();
            tokio::pin!(resumed);
            resumed.as_mut().enable();
            if self.cancelled.load(Ordering::Relaxed) {
                return Err(Error::Validation("Execution cancelled".into()));
            }
            if !self.paused.load(Ordering::Relaxed) {
                return Ok(started.elapsed());
            }
            resumed.await;
        }
    }
    /// The delay between requests, which a pause stops and a cancel ends. Returns how long
    /// the run was paused in it.
    pub(super) async fn delay(&self, delay: Duration) -> Result<Duration> {
        let mut paused = Duration::ZERO;
        let mut left = delay;
        while !left.is_zero() {
            paused += self.wait_while_paused().await?;
            let step = left.min(Duration::from_millis(50));
            tokio::time::sleep(step).await;
            left -= step;
        }
        paused += self.wait_while_paused().await?;
        Ok(paused)
    }
    /// The job as returned to clients, with secrets redacted.
    pub fn view(&self) -> Value {
        self.view_since(&Cursor::default())
    }
    /// Only the results, assertions and logs after `cursor`; `counts` is the next cursor.
    pub fn view_since(&self, cursor: &Cursor) -> Value {
        let state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        let after =
            |items: &[Value], skip: usize| items.iter().skip(skip).cloned().collect::<Vec<_>>();
        let mut view = json!({
            "id": self.id,
            "state": state.state,
            "results": after(&state.results, cursor.results),
            "assertions": after(&state.assertions, cursor.assertions),
            "logs": after(&state.logs, cursor.logs),
            "counts": {
                "results": state.results.len(),
                "assertions": state.assertions.len(),
                "logs": state.logs.len(),
            },
            "startedAt": self.started_at,
        });
        if self.paused.load(Ordering::Relaxed) && state.state == "paused" {
            view["paused"] = json!(true);
        }
        if let Some(error) = &state.error {
            view["error"] = json!(error);
        }
        if !matches!(state.state.as_str(), "running" | "paused") {
            view["duration"] = json!(state.duration);
            view["environment"] = state.environment.clone();
            view["globals"] = state.globals.clone();
            view["collectionVariables"] = state.collection_variables.clone();
        }
        redact(&view, &self.secrets)
    }
}

/// Position of a client in a run's results, assertions and logs.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct Cursor {
    pub results: usize,
    pub assertions: usize,
    pub logs: usize,
}
impl Cursor {
    /// Reads `{results, assertions, logs}`; missing fields start at zero.
    pub fn from_value(value: &Value) -> Self {
        let count = |key: &str| value[key].as_u64().unwrap_or(0) as usize;
        Self {
            results: count("results"),
            assertions: count("assertions"),
            logs: count("logs"),
        }
    }
}

pub(super) fn finish(job: &Job, outcome: Result<Outcome>) {
    let mut state = job.state.lock().unwrap_or_else(|e| e.into_inner());
    state.duration = job.started.elapsed().as_millis() as u64;
    state.finished_at = Some(Instant::now());
    match outcome {
        Ok(outcome) => {
            state.environment = json!({"values": rows(&outcome.environment)});
            state.globals = json!({"values": rows(&outcome.globals)});
            state.collection_variables = Value::Array(
                outcome
                    .collection
                    .iter()
                    .map(|(k, v)| json!({"key": k, "value": v}))
                    .collect(),
            );
            if matches!(state.state.as_str(), "running" | "paused") {
                state.state = if outcome.failure.is_some() {
                    "failed"
                } else {
                    "completed"
                }
                .into();
            }
            state.error = state.error.take().or(outcome.failure);
        }
        Err(error) => {
            if matches!(state.state.as_str(), "running" | "paused") {
                state.state = "failed".into();
            }
            state.error = Some(error.to_string());
        }
    }
    drop(state);
    job.done.notify_waiters();
}

pub(super) struct Outcome {
    pub(super) environment: Map<String, Value>,
    pub(super) globals: Map<String, Value>,
    pub(super) collection: Map<String, Value>,
    pub(super) failure: Option<String>,
}
