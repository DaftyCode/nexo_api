//! Load tests: virtual users repeat one request for a duration.
use crate::runner::Runs;
use nexo_domain::{Error, Result};
use serde_json::{Value, json};
use std::{
    collections::{HashMap, VecDeque},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

const KEEP_FINISHED: Duration = Duration::from_secs(30 * 60);
const MAX_SAMPLES: usize = 10_000;

#[derive(Default)]
struct State {
    state: String,
    completed: u64,
    errors: u64,
    times: VecDeque<f64>,
    duration: u64,
    summary: Option<Value>,
    finished: Option<Instant>,
}
struct Job {
    id: String,
    started: Instant,
    started_at: u64,
    state: Mutex<State>,
}
impl Job {
    fn running(&self) -> bool {
        self.state.lock().unwrap_or_else(|e| e.into_inner()).state == "running"
    }
    fn view(&self) -> Value {
        let state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        let mut sorted: Vec<f64> = state.times.iter().copied().collect();
        sorted.sort_by(f64::total_cmp);
        let percentile = |fraction: f64| {
            if sorted.is_empty() {
                0.0
            } else {
                sorted[((sorted.len() as f64 * fraction) as usize).min(sorted.len() - 1)]
            }
        };
        let average = sorted.iter().sum::<f64>() / (sorted.len().max(1) as f64);
        let mut view = json!({
            "id": self.id,
            "state": state.state,
            "completed": state.completed,
            "errors": state.errors,
            "startedAt": self.started_at,
            "duration": state.duration,
            "samples": sorted.len(),
            "average": average,
            "p50": percentile(0.5),
            "p95": percentile(0.95),
            "elapsed": if state.state == "running" { self.started.elapsed().as_millis() as u64 } else { state.duration },
        });
        if let Some(summary) = &state.summary {
            view["summary"] = summary.clone();
        }
        view
    }
}

pub struct Performance {
    jobs: Mutex<HashMap<String, Arc<Job>>>,
    runs: Arc<Runs>,
}
impl Performance {
    pub fn new(runs: Arc<Runs>) -> Self {
        Self {
            jobs: Mutex::new(HashMap::new()),
            runs,
        }
    }
    fn job(&self, id: &str) -> Result<Arc<Job>> {
        self.jobs
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(id)
            .cloned()
            .ok_or_else(|| Error::Validation("Performance run not found".into()))
    }
    pub fn status(&self, id: &str) -> Result<Value> {
        Ok(self.job(id)?.view())
    }
    pub fn cancel(&self, id: &str) -> Result<Value> {
        let job = self.job(id)?;
        {
            let mut state = job.state.lock().unwrap_or_else(|e| e.into_inner());
            if state.state == "running" {
                state.state = "cancelled".into();
            }
        }
        Ok(job.view())
    }
    pub fn close(&self) {
        for job in self.jobs.lock().unwrap_or_else(|e| e.into_inner()).values() {
            let mut state = job.state.lock().unwrap_or_else(|e| e.into_inner());
            if state.state == "running" {
                state.state = "cancelled".into();
            }
        }
    }
    pub fn start(&self, payload: &Value) -> Result<Value> {
        if payload["request"].is_null() {
            return Err(Error::Validation("Open a request first".into()));
        }
        self.jobs
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .retain(|_, job| {
                job.state
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .finished
                    .is_none_or(|finished| finished.elapsed() < KEEP_FINISHED)
            });
        let id = uuid::Uuid::new_v4().to_string();
        let job = Arc::new(Job {
            id: id.clone(),
            started: Instant::now(),
            started_at: std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0),
            state: Mutex::new(State {
                state: "running".into(),
                ..Default::default()
            }),
        });
        self.jobs
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(id.clone(), job.clone());
        let users = payload["users"].as_u64().unwrap_or(1).clamp(1, 4);
        let duration =
            Duration::from_secs(payload["duration"].as_u64().unwrap_or(10).clamp(1, 120));
        let ramp = payload["profile"] == "ramp-up";
        let mut iteration = json!({"timeout": 15000});
        for key in [
            "request",
            "variables",
            "globals",
            "context",
            "resolvedSecrets",
            "secretHosts",
            "strictSSL",
            "followRedirects",
            "workspace",
        ] {
            if let Some(value) = payload.get(key) {
                iteration[key] = value.clone();
            }
        }
        let runs = self.runs.clone();
        tokio::spawn(async move {
            let mut users_tasks = Vec::new();
            for index in 0..users {
                let (job, runs, iteration) = (job.clone(), runs.clone(), iteration.clone());
                users_tasks.push(tokio::spawn(async move {
                    if ramp {
                        tokio::time::sleep(duration.mul_f64(index as f64 / users as f64 / 2.0))
                            .await;
                    }
                    while job.running() && job.started.elapsed() < duration {
                        let outcome = runs.request(iteration.clone(), false).await;
                        let failed = {
                            let mut state = job.state.lock().unwrap_or_else(|e| e.into_inner());
                            match &outcome {
                                Ok(result) => {
                                    state.completed += 1;
                                    state
                                        .times
                                        .push_back(result["time"].as_f64().unwrap_or(0.0));
                                    if !result["error"].is_null()
                                        || result["status"].as_u64().unwrap_or(0) >= 400
                                    {
                                        state.errors += 1;
                                    }
                                }
                                Err(_) => state.errors += 1,
                            }
                            while state.times.len() > MAX_SAMPLES {
                                state.times.pop_front();
                            }
                            outcome.is_err()
                        };
                        // Avoid a tight loop when the limit of concurrent executions is reached.
                        if failed {
                            tokio::time::sleep(Duration::from_millis(50)).await;
                        }
                    }
                }));
            }
            for task in users_tasks {
                let _ = task.await;
            }
            let duration = job.started.elapsed().as_millis() as u64;
            {
                let mut state = job.state.lock().unwrap_or_else(|e| e.into_inner());
                if state.state == "running" {
                    state.state = "completed".into();
                }
                state.duration = duration;
                state.finished = Some(Instant::now());
            }
            let view = job.view();
            let mut state = job.state.lock().unwrap_or_else(|e| e.into_inner());
            state.summary = Some(json!({
                "requests": state.completed,
                "errors": state.errors,
                "average": view["average"],
                "p50": view["p50"],
                "p95": view["p95"],
                "rps": state.completed as f64 / (duration.max(1) as f64 / 1000.0),
            }));
        });
        Ok(json!({"id": id, "state": "running"}))
    }
}
