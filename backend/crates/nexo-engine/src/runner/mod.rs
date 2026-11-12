//! Collection runs and single requests: variables, scripts, transport and results.

mod databases;
mod execute;
mod job;
mod steps;

pub use crate::cookies::Jars;
use crate::{
    collection::{as_collection, request_url},
    egress::Policy,
    scripts::ScriptSession,
    transport::{Options, Transport, transport_settings},
    vault::Vault,
};
use base64::{Engine as _, engine::general_purpose::STANDARD};
pub use databases::ScriptDatabases;
use execute::execute;
pub use job::{Cursor, Job};
use job::{JobState, Outcome, finish};
use nexo_domain::{Error, Result};
use serde_json::{Map, Value, json};
use std::{
    collections::HashMap,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant},
};
use steps::{flatten, rows, scripts, session_secrets};
pub use steps::{request_auth, resolved_auth, values};

const MAX_ACTIVE_RUNS: usize = 8;
const KEEP_FINISHED: Duration = Duration::from_secs(10 * 60);
const MIN_REDACTED_LENGTH: usize = 4;

/// Forms in which a secret commonly appears: as is, URL-encoded, JSON-escaped and base64.
pub fn secret_variants(secrets: &[String]) -> Vec<String> {
    let mut variants: Vec<String> = Vec::new();
    for secret in secrets.iter().filter(|s| s.len() >= MIN_REDACTED_LENGTH) {
        let json = serde_json::to_string(secret).unwrap_or_default();
        let base64 = STANDARD.encode(secret.as_bytes());
        for variant in [
            secret.clone(),
            crate::collection::encode_component(secret),
            json[1..json.len() - 1].to_string(),
            base64.trim_end_matches('=').to_string(),
            base64,
        ] {
            if variant.len() >= MIN_REDACTED_LENGTH && !variants.contains(&variant) {
                variants.push(variant);
            }
        }
    }
    variants.sort_by_key(|v| std::cmp::Reverse(v.len()));
    variants
}
pub fn redact(value: &Value, secrets: &[String]) -> Value {
    if secrets.is_empty() {
        return value.clone();
    }
    match value {
        Value::String(text) => Value::String(secrets.iter().fold(text.clone(), |text, secret| {
            text.replace(secret.as_str(), "[REDACTED]")
        })),
        Value::Array(items) => {
            Value::Array(items.iter().map(|item| redact(item, secrets)).collect())
        }
        Value::Object(map) => Value::Object(
            map.iter()
                .map(|(k, v)| (k.clone(), redact(v, secrets)))
                .collect(),
        ),
        other => other.clone(),
    }
}

pub fn cookie_scope(payload: &Value) -> String {
    payload["workspace"].as_str().unwrap_or("local").to_string()
}

/// Settings shared by every execution.
#[derive(Clone)]
pub struct Context {
    pub egress: Policy,
    pub loopback_ports: Arc<dyn Fn() -> Vec<u16> + Send + Sync>,
    /// Where `nx.oauth2.reset(name)` deletes OAuth 2.0 tokens; `None` in tests without one.
    pub vault: Option<Arc<Vault>>,
    /// Where `nx.mongo` calls go, once the composition root connects the application.
    pub databases: ScriptDatabases,
}

pub struct Runs {
    jobs: Mutex<HashMap<String, Arc<Job>>>,
    pub jars: Arc<Jars>,
    context: Context,
}
impl Runs {
    pub fn new(jars: Arc<Jars>, context: Context) -> Self {
        Self {
            jobs: Mutex::new(HashMap::new()),
            jars,
            context,
        }
    }
    fn sweep(&self) {
        let mut jobs = self.jobs.lock().unwrap_or_else(|e| e.into_inner());
        jobs.retain(|_, job| {
            job.state
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .finished_at
                .is_none_or(|finished| finished.elapsed() < KEEP_FINISHED)
        });
    }
    /// Starts an execution on its own thread and returns its identifier.
    pub fn start(&self, payload: Value) -> Result<Arc<Job>> {
        self.sweep();
        let id = payload["id"]
            .as_str()
            .map(String::from)
            .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
        let secrets: Vec<String> = session_secrets(&payload)
            .values()
            .filter_map(Value::as_str)
            .map(String::from)
            .collect();
        let job = Arc::new(Job {
            id: id.clone(),
            started: Instant::now(),
            started_at: std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0),
            state: Mutex::new(JobState {
                state: "running".into(),
                ..Default::default()
            }),
            cancelled: Arc::new(AtomicBool::new(false)),
            paused: AtomicBool::new(false),
            resumed: tokio::sync::Notify::new(),
            secrets: secret_variants(&secrets),
            done: tokio::sync::Notify::new(),
        });
        {
            let mut jobs = self.jobs.lock().unwrap_or_else(|e| e.into_inner());
            if jobs.values().filter(|job| job.running()).count() >= MAX_ACTIVE_RUNS {
                return Err(Error::Validation("Maximum of eight active runs".into()));
            }
            if jobs.contains_key(&id) {
                return Err(Error::Validation(
                    "This execution identifier already exists".into(),
                ));
            }
            jobs.insert(id, job.clone());
        }
        let (worker, jars, context) = (job.clone(), self.jars.clone(), self.context.clone());
        std::thread::Builder::new()
            .name("nexo-run".into())
            .spawn(move || {
                let runtime = tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build();
                let outcome = match runtime {
                    Ok(runtime) => runtime.block_on(execute(&payload, &worker, &jars, &context)),
                    Err(error) => Err(Error::Infrastructure(error.to_string())),
                };
                // Saved before it reports the end, so a restart right after keeps the cookies.
                jars.save(&cookie_scope(&payload));
                finish(&worker, outcome);
            })
            .map_err(|error| Error::Infrastructure(error.to_string()))?;
        Ok(job)
    }
    fn job(&self, id: &str) -> Result<Arc<Job>> {
        self.jobs
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(id)
            .cloned()
            .ok_or_else(|| Error::Validation("Execution not found".into()))
    }
    pub fn status(&self, id: &str, cursor: &Cursor) -> Result<Value> {
        Ok(self.job(id)?.view_since(cursor))
    }
    pub fn cancel(&self, id: &str) -> Result<Value> {
        let job = self.job(id)?;
        if job.running() {
            job.cancelled.store(true, Ordering::Relaxed);
            {
                let mut state = job.state.lock().unwrap_or_else(|e| e.into_inner());
                state.state = "cancelled".into();
                state.finished_at = Some(Instant::now());
            }
            // A paused run wakes up to stop.
            job.resumed.notify_waiters();
        }
        Ok(job.view())
    }
    /// Pauses a run between requests: the one being sent finishes, no other starts.
    pub fn pause(&self, id: &str) -> Result<Value> {
        let job = self.job(id)?;
        if job.running() {
            job.paused.store(true, Ordering::Relaxed);
            job.set_state("paused");
        }
        Ok(job.view())
    }
    /// Continues a paused run with its next request.
    pub fn resume(&self, id: &str) -> Result<Value> {
        let job = self.job(id)?;
        if job.running() {
            job.paused.store(false, Ordering::Relaxed);
            job.set_state("running");
            job.resumed.notify_waiters();
        }
        Ok(job.view())
    }
    /// Cancels every running execution, when the engine stops.
    pub fn cancel_all(&self) {
        for job in self.jobs.lock().unwrap_or_else(|e| e.into_inner()).values() {
            job.cancelled.store(true, Ordering::Relaxed);
            job.resumed.notify_waiters();
        }
    }
    /// Runs one request and waits for it, as the interface's Send button does.
    pub async fn request(&self, payload: Value, keep: bool) -> Result<Value> {
        let job = self.start(payload)?;
        loop {
            let notified = job.done.notified();
            if !job.running() {
                break;
            }
            notified.await;
        }
        if !keep {
            self.jobs
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .remove(&job.id);
        }
        let view = job.view();
        let results = view["results"].as_array().cloned().unwrap_or_default();
        if results.is_empty()
            && let Some(error) = view["error"].as_str()
        {
            return Err(Error::Validation(error.to_string()));
        }
        let mut result = results.last().cloned().unwrap_or_else(|| json!({}));
        result["assertions"] = view["assertions"].clone();
        result["logs"] = view["logs"].clone();
        result["executionId"] = json!(job.id);
        result["variables"] = json!({
            "environment": view["environment"],
            "globals": view["globals"],
            "collection": view["collectionVariables"],
        });
        Ok(result)
    }
}

#[cfg(test)]
mod tests;
