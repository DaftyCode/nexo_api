//! Collection runs and single requests: variables, scripts, transport and results.
pub use crate::cookies::Jars;
use crate::{
    collection::{as_collection, request_url},
    egress::Policy,
    scripts::ScriptSession,
    transport::{Options, Transport, transport_settings},
    vault::Vault,
};
use base64::{Engine as _, engine::general_purpose::STANDARD};
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

#[derive(Default)]
struct JobState {
    state: String,
    results: Vec<Value>,
    assertions: Vec<Value>,
    logs: Vec<Value>,
    error: Option<String>,
    duration: u64,
    environment: Value,
    globals: Value,
    collection_variables: Value,
    finished_at: Option<Instant>,
}
pub struct Job {
    id: String,
    started: Instant,
    started_at: u64,
    state: Mutex<JobState>,
    cancelled: Arc<AtomicBool>,
    /// Paused between requests; the request being sent finishes first.
    paused: AtomicBool,
    /// Wakes a paused run when it is resumed or cancelled.
    resumed: tokio::sync::Notify,
    secrets: Vec<String>,
    done: tokio::sync::Notify,
}
impl Job {
    pub fn id(&self) -> &str {
        &self.id
    }
    #[cfg(test)]
    fn done_state_settled(&self) -> bool {
        self.state
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .duration
            > 0
    }
    /// Running or paused: not finished yet.
    fn running(&self) -> bool {
        matches!(
            self.state
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .state
                .as_str(),
            "running" | "paused"
        )
    }
    fn set_state(&self, state: &str) {
        self.state.lock().unwrap_or_else(|e| e.into_inner()).state = state.into();
    }
    /// Waits while the run is paused, and returns how long it waited. A cancelled run stops.
    async fn wait_while_paused(&self) -> Result<Duration> {
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
    async fn delay(&self, delay: Duration) -> Result<Duration> {
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

/// Settings shared by every execution.
#[derive(Clone)]
pub struct Context {
    pub egress: Policy,
    pub loopback_ports: Arc<dyn Fn() -> Vec<u16> + Send + Sync>,
    /// Where `nx.oauth2.reset(name)` deletes OAuth 2.0 tokens; `None` in tests without one.
    pub vault: Option<Arc<Vault>>,
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

fn finish(job: &Job, outcome: Result<Outcome>) {
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
fn rows(map: &Map<String, Value>) -> Vec<Value> {
    map.iter()
        .map(|(key, value)| json!({"key": key, "value": value, "enabled": true}))
        .collect()
}

/// Enabled `{key, value}` rows as a map; later rows win.
pub fn values(rows: &Value) -> Map<String, Value> {
    let mut map = Map::new();
    for row in rows.as_array().into_iter().flatten() {
        if row["enabled"] == false || row["disabled"] == true {
            continue;
        }
        if let Some(key) = row["key"].as_str().filter(|k| !k.is_empty()) {
            map.insert(
                key.to_string(),
                row.get("value").cloned().unwrap_or(json!("")),
            );
        }
    }
    map
}

struct Outcome {
    environment: Map<String, Value>,
    globals: Map<String, Value>,
    collection: Map<String, Value>,
    failure: Option<String>,
}
/// Secrets a session resolves and redacts: vault secrets as `vault:<name>`, and OAuth 2.0
/// token variables (`$oauth2.<name>.access_token`) added by the engine.
fn session_secrets(payload: &Value) -> Map<String, Value> {
    let mut secrets: Map<String, Value> = payload["resolvedSecrets"]
        .as_object()
        .map(|map| {
            map.iter()
                .map(|(k, v)| (format!("vault:{k}"), v.clone()))
                .collect()
        })
        .unwrap_or_default();
    if let Some(variables) = payload["resolvedOAuth2"].as_object() {
        secrets.extend(variables.clone());
    }
    secrets
}
struct Step {
    item: Value,
    parents: Vec<Value>,
}
impl Step {
    /// The request to send, with the authorization of the nearest folder or collection
    /// when it inherits one.
    fn request(&self) -> Value {
        let mut request = match &self.item["request"] {
            Value::String(url) => json!({"method": "GET", "url": url}),
            Value::Object(_) => self.item["request"].clone(),
            _ => json!({}),
        };
        if request.get("auth").is_none_or(Value::is_null)
            && let Some(auth) = self
                .parents
                .iter()
                .rev()
                .find_map(|group| group.get("auth").filter(|a| a.is_object()))
        {
            request["auth"] = auth.clone();
        }
        request
    }
    /// Variables of the folders around the request and of the request itself, nearest last.
    fn layered_variables(&self) -> Map<String, Value> {
        let mut layered = Map::new();
        for group in self.parents.iter().skip(1) {
            layered.extend(values(&group["variable"]));
        }
        layered.extend(values(&self.item["variable"]));
        layered
    }
}

/// The first request of a payload and its authorization: its own or the inherited one,
/// before its variables are replaced.
fn authorized_step(payload: &Value) -> Result<(Value, Step)> {
    let collection = as_collection(payload)?;
    let mut steps = Vec::new();
    flatten(&collection, &[], &mut steps);
    let step = steps
        .into_iter()
        .next()
        .ok_or_else(|| Error::Validation("Nothing to authorize".into()))?;
    if !step.request()["auth"].is_object() {
        return Err(Error::Validation(
            "No authorization is set for this request".into(),
        ));
    }
    Ok((collection, step))
}
/// The authorization a request would be sent with, before its variables are replaced.
pub fn request_auth(payload: &Value) -> Result<Value> {
    Ok(authorized_step(payload)?.1.request()["auth"].clone())
}
/// The authorization a request would be sent with: the request's own or the inherited one,
/// with `{{variables}}` and vault secrets replaced exactly as when it is sent.
pub fn resolved_auth(payload: &Value) -> Result<Map<String, Value>> {
    let (collection, step) = authorized_step(payload)?;
    let auth = step.request()["auth"].clone();
    let mut collection_variables = values(&collection["variable"]);
    collection_variables.extend(step.layered_variables());
    let secrets = session_secrets(payload);
    let seed = json!({
        "environment": values(&payload["variables"]),
        "globals": values(&payload["globals"]),
        "local": {},
        "collection": collection_variables,
        "data": {},
        "secrets": secrets,
        "request": {"auth": auth},
        "iteration": 0,
        "iterationCount": 1,
        "requestName": step.item["name"],
        "requestId": step.item["id"],
        "uuid": uuid::Uuid::new_v4().to_string(),
    });
    let session = ScriptSession::new(&seed, Arc::new(AtomicBool::new(false)))?;
    Ok(crate::auth::values(&session.replace(&auth)?))
}
fn flatten(group: &Value, parents: &[Value], output: &mut Vec<Step>) {
    let mut chain = parents.to_vec();
    chain.push(group.clone());
    for item in group["item"].as_array().into_iter().flatten() {
        if item["item"].is_array() {
            flatten(item, &chain, output);
        } else {
            output.push(Step {
                item: item.clone(),
                parents: chain.clone(),
            });
        }
    }
}
fn scripts(groups: &[&Value], listen: &str) -> Vec<String> {
    groups
        .iter()
        .flat_map(|group| group["event"].as_array().into_iter().flatten())
        .filter(|event| event["listen"] == listen)
        .map(|event| match &event["script"]["exec"] {
            Value::Array(lines) => lines
                .iter()
                .filter_map(Value::as_str)
                .collect::<Vec<_>>()
                .join("\n"),
            Value::String(text) => text.clone(),
            _ => String::new(),
        })
        .filter(|source| !source.trim().is_empty())
        .collect()
}

/// Runs every step. Variables changed before a failure are still returned.
async fn execute(payload: &Value, job: &Job, jars: &Jars, context: &Context) -> Result<Outcome> {
    let mut outcome = Outcome {
        environment: values(&payload["variables"]),
        globals: values(&payload["globals"]),
        collection: Map::new(),
        failure: None,
    };
    if let Err(error) = run_steps(payload, job, jars, context, &mut outcome).await {
        outcome.failure = Some(error.to_string());
    }
    Ok(outcome)
}
async fn run_steps(
    payload: &Value,
    job: &Job,
    jars: &Jars,
    context: &Context,
    outcome: &mut Outcome,
) -> Result<()> {
    let collection = as_collection(payload)?;
    let mut steps = Vec::new();
    flatten(&collection, &[], &mut steps);
    let secrets = session_secrets(payload);
    let restricted = crate::secret_hosts::restricted(payload);
    // Files chosen for this request; collection runs from the interface bring none.
    let files = crate::files::Files::from_payload(payload)?;
    let jar = jars.get(&cookie_scope(payload));
    outcome.collection = values(&collection["variable"]);
    let mut local = Map::new();
    let iterations = payload["iterations"].as_u64().unwrap_or(1).clamp(1, 10_000);
    let mut deadline = Instant::now()
        + Duration::from_millis(
            payload["globalTimeout"]
                .as_u64()
                .unwrap_or(300_000)
                .min(3_600_000),
        );
    // Postman's "Delay" between requests, up to a minute.
    let delay = Duration::from_millis(payload["delay"].as_u64().unwrap_or(0).min(60_000));
    let mut first = true;
    let mut transports: HashMap<String, Transport> = HashMap::new();
    'iterations: for iteration in 0..iterations {
        let mut index = 0usize;
        let mut steps_taken = 0usize;
        while index < steps.len() {
            if job.cancelled.load(Ordering::Relaxed) {
                return Err(Error::Validation("Execution cancelled".into()));
            }
            // Waits the delay between requests, and while paused; time paused does not count
            // towards the run time limit.
            let waited = if first {
                job.wait_while_paused().await?
            } else {
                job.delay(delay).await?
            };
            first = false;
            deadline += waited;
            if Instant::now() > deadline || steps_taken > 10_000 {
                return Err(Error::Validation("Execution exceeded time limit".into()));
            }
            steps_taken += 1;
            let step = &steps[index];
            let item = &step.item;
            let request = step.request();
            let layered = step.layered_variables();
            let mut collection_variables = outcome.collection.clone();
            collection_variables.extend(layered.clone());
            let seed = json!({
                "environment": outcome.environment,
                "globals": outcome.globals,
                "local": local,
                "collection": collection_variables,
                "data": payload["data"].get(iteration as usize).cloned().unwrap_or(json!({})),
                "secrets": secrets,
                "request": request,
                "iteration": iteration,
                "iterationCount": iterations,
                "requestName": item["name"],
                "requestId": item["id"],
                "uuid": uuid::Uuid::new_v4().to_string(),
            });
            let transport_key = item["nexoTransport"]
                .as_str()
                .filter(|t| !t.trim().is_empty())
                .unwrap_or("")
                .to_string();
            if !transports.contains_key(&transport_key) {
                let settings = if transport_key.is_empty() {
                    transport_settings(
                        payload
                            .get("transport")
                            .unwrap_or(&payload["request"]["transport"]),
                    )?
                } else {
                    transport_settings(&Value::String(transport_key.clone()))?
                };
                let options = Options::from_payload(
                    payload,
                    &settings,
                    context.egress.clone(),
                    (context.loopback_ports)(),
                );
                transports.insert(transport_key.clone(), Transport::new(options, jar.clone())?);
            }
            let transport = &transports[&transport_key];
            let session = ScriptSession::new(&seed, job.cancelled.clone())?;
            let groups: Vec<&Value> = step.parents.iter().chain(std::iter::once(item)).collect();
            session.run(&scripts(&groups, "prerequest"), None)?;
            send_queued(&session, transport).await?;
            let state = session.snapshot()?;
            if state["skip"] != true {
                // Script variables first; where restricted secrets go is read from the
                // references left in that result, right before the host fills them.
                let substituted = session.replace_variables(&state["request"])?;
                let placements = crate::secret_hosts::placements(&restricted, &substituted);
                let mut outgoing = session.fill_secrets(&substituted);
                files.attach(&mut outgoing);
                let url = request_url(&outgoing["url"]);
                outgoing["url"] = json!(url);
                let mut result = match transport.request(&outgoing, &placements).await {
                    Ok(result) => result,
                    Err(error) => {
                        outcome.failure.get_or_insert_with(|| error.to_string());
                        json!({"url": url, "method": outgoing["method"], "status": 0, "statusText": "", "body": "",
                               "headers": [], "cookies": [], "size": 0, "time": 0, "error": error.to_string()})
                    }
                };
                result["id"] = item["id"].clone();
                result["name"] = item.get("name").cloned().unwrap_or(json!(url));
                result["iteration"] = json!(iteration);
                // The contents of the files are not returned: only their names.
                result["request"] = crate::files::without_contents(outgoing);
                job.state
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .results
                    .push(result.clone());
                session.run(&scripts(&groups, "test"), Some(&result))?;
                send_queued(&session, transport).await?;
            }
            let state = session.snapshot()?;
            // `nx.oauth2.reset(name)`: the next send gets a new token (Bruno's
            // `bru.resetOauth2Credential`). Scripts can delete tokens but never read them.
            if let (Some(vault), Some(names)) = (&context.vault, state["oauth2Resets"].as_array()) {
                for name in names.iter().filter_map(Value::as_str) {
                    crate::oauth2_tokens::delete_named(vault, name).await?;
                }
            }
            outcome.environment = state["environment"]
                .as_object()
                .cloned()
                .unwrap_or_default();
            outcome.globals = state["globals"].as_object().cloned().unwrap_or_default();
            local.extend(state["local"].as_object().cloned().unwrap_or_default());
            let collection_after = state["collection"].as_object().cloned().unwrap_or_default();
            let mut before = outcome.collection.clone();
            before.extend(layered);
            for (key, value) in &collection_after {
                if before.get(key) != Some(value) {
                    outcome.collection.insert(key.clone(), value.clone());
                }
            }
            for key in before.keys() {
                if !collection_after.contains_key(key) {
                    outcome.collection.shift_remove(key);
                }
            }
            {
                let mut shared = job.state.lock().unwrap_or_else(|e| e.into_inner());
                shared
                    .assertions
                    .extend(state["assertions"].as_array().cloned().unwrap_or_default());
                let room = 1000usize.saturating_sub(shared.logs.len());
                shared.logs.extend(
                    state["logs"]
                        .as_array()
                        .cloned()
                        .unwrap_or_default()
                        .into_iter()
                        .take(room),
                );
            }
            match &state["next"] {
                Value::Null if state.get("next").is_some() => break 'iterations,
                Value::String(next) => {
                    let target = steps
                        .iter()
                        .position(|s| {
                            s.item["id"].as_str() == Some(next)
                                || s.item["name"].as_str() == Some(next)
                        })
                        .ok_or_else(|| Error::Validation("Next request was not found".into()))?;
                    index = target;
                    continue;
                }
                _ => {}
            }
            index += 1;
        }
    }
    Ok(())
}

/// Sends requests queued by `pm.sendRequest` and delivers their responses.
async fn send_queued(session: &ScriptSession, transport: &Transport) -> Result<()> {
    for _round in 0..100 {
        let queue = session.take_queue()?;
        if queue.is_empty() {
            return Ok(());
        }
        for (id, request) in queue {
            let mut request = request;
            if let Some(url) = request.get("url").map(request_url) {
                request["url"] = json!(url);
            }
            // Scripts cannot use vault secrets, so their requests carry none.
            match transport.request(&request, &[]).await {
                Ok(result) => session.deliver(&id, Some(&result), None)?,
                Err(error) => session.deliver(&id, None, Some(&error.to_string()))?,
            }
        }
    }
    Err(Error::Validation("Script request limit exceeded".into()))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn redaction_covers_encoded_forms() {
        let variants = secret_variants(&["p@ss word!".into(), "ab".into()]);
        let text = format!(
            "p@ss word! {} {} ab-cd",
            crate::collection::encode_component("p@ss word!"),
            STANDARD.encode("p@ss word!")
        );
        assert_eq!(
            redact(&json!(text), &variants),
            json!("[REDACTED] [REDACTED] [REDACTED] ab-cd")
        );
    }
    #[test]
    fn values_skip_disabled_rows() {
        let map = values(&json!([
            {"key": "a", "value": "1"},
            {"key": "b", "value": "2", "enabled": false},
            {"key": "c", "value": "3", "disabled": true},
            {"key": "a", "value": "4"}
        ]));
        assert_eq!(map, Map::from_iter([("a".to_string(), json!("4"))]));
    }

    async fn server() -> String {
        use axum::{Router, http::HeaderMap, routing::get};
        let app = Router::new()
            .route(
                "/login",
                get(|| async {
                    (
                        [("set-cookie", "session=abc; Path=/")],
                        "{\"token\":\"tok-12345\"}",
                    )
                }),
            )
            .route(
                "/remember",
                get(|| async { ([("set-cookie", "remember=yes; Path=/; Max-Age=3600")], "ok") }),
            )
            .route(
                "/echo",
                get(|headers: HeaderMap| async move {
                    format!(
                        "auth={} cookie={}",
                        headers
                            .get("authorization")
                            .and_then(|v| v.to_str().ok())
                            .unwrap_or(""),
                        headers
                            .get("cookie")
                            .and_then(|v| v.to_str().ok())
                            .unwrap_or("")
                    )
                }),
            );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        format!("http://{address}")
    }
    fn runs() -> Runs {
        let directory = std::env::temp_dir().join(format!("nexo-jars-{}", uuid::Uuid::new_v4()));
        Runs::new(
            Arc::new(Jars::new(directory)),
            Context {
                egress: Policy::AllowAll,
                loopback_ports: Arc::new(Vec::new),
                vault: None,
            },
        )
    }
    fn exec(lines: &str, listen: &str) -> Value {
        json!([{"listen": listen, "script": {"exec": lines.lines().collect::<Vec<_>>()}}])
    }

    /// A server that counts the requests it receives.
    async fn counting() -> (String, Arc<std::sync::atomic::AtomicUsize>) {
        use axum::{Router, routing::get};
        use std::sync::atomic::AtomicUsize;
        let count = Arc::new(AtomicUsize::new(0));
        let counter = count.clone();
        let app = Router::new().route(
            "/count",
            get(move || {
                let counter = counter.clone();
                async move { counter.fetch_add(1, Ordering::SeqCst).to_string() }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        (format!("http://{address}/count"), count)
    }
    fn ten_requests(url: &str) -> Value {
        json!({"info": {"name": "c"}, "item": (0..10)
            .map(|i| json!({"id": i.to_string(), "name": format!("r{i}"), "request": {"method": "GET", "url": url}}))
            .collect::<Vec<_>>()})
    }
    async fn until(check: impl Fn() -> bool) {
        for _ in 0..500 {
            if check() {
                return;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        panic!("timed out");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_paused_run_stops_between_requests_and_resumes_with_the_next() {
        use std::sync::atomic::Ordering::SeqCst;
        let (url, count) = counting().await;
        let runs = runs();
        let job = runs
            .start(json!({"collection": ten_requests(&url), "delay": 40, "globalTimeout": 5_000}))
            .unwrap();
        until(|| count.load(SeqCst) >= 3).await;
        let view = runs.pause(job.id()).unwrap();
        assert_eq!(view["state"], "paused");
        assert_eq!(view["paused"], true);
        assert!(
            view.get("duration").is_none(),
            "a paused run is not finished"
        );
        // The request being sent may finish; then nothing more is sent.
        tokio::time::sleep(Duration::from_millis(150)).await;
        let stopped = count.load(SeqCst);
        tokio::time::sleep(Duration::from_millis(300)).await;
        assert_eq!(count.load(SeqCst), stopped);
        assert!(stopped < 10);
        assert!(job.running());
        // Pausing longer than the run's time limit does not make it fail.
        tokio::time::sleep(Duration::from_millis(5_100)).await;
        assert_eq!(count.load(SeqCst), stopped);
        assert_eq!(runs.resume(job.id()).unwrap()["state"], "running");
        until(|| !job.running()).await;
        let view = job.view();
        assert_eq!(view["state"], "completed", "{view}");
        assert_eq!(count.load(SeqCst), 10);
        assert_eq!(view["results"].as_array().unwrap().len(), 10);
        // Pausing or resuming a finished run changes nothing.
        assert_eq!(runs.pause(job.id()).unwrap()["state"], "completed");
        assert_eq!(runs.resume(job.id()).unwrap()["state"], "completed");
        assert!(runs.pause("missing").is_err());
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn cancelling_a_paused_run_ends_it() {
        use std::sync::atomic::Ordering::SeqCst;
        let (url, count) = counting().await;
        let runs = runs();
        let job = runs
            .start(json!({"collection": ten_requests(&url), "delay": 1_000}))
            .unwrap();
        until(|| count.load(SeqCst) >= 1).await;
        // Paused during the delay: it does not go on when the delay would end.
        runs.pause(job.id()).unwrap();
        tokio::time::sleep(Duration::from_millis(1_300)).await;
        assert_eq!(count.load(SeqCst), 1);
        assert_eq!(runs.cancel(job.id()).unwrap()["state"], "cancelled");
        until(|| job.done_state_settled()).await;
        assert_eq!(job.view()["state"], "cancelled");
        assert_eq!(count.load(SeqCst), 1);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn collection_runs_scripts_scopes_and_cookies() {
        let base = server().await;
        let collection = json!({
            "info": {"name": "c"},
            "variable": [{"key": "base", "value": base}],
            "event": exec("pm.collectionVariables.set('seen', (pm.collectionVariables.get('seen') || 0) + 1);", "prerequest"),
            "item": [
                {"id": "1", "name": "login", "request": {"method": "GET", "url": "{{base}}/login"},
                 "event": exec("pm.environment.set('token', pm.response.json().token); pm.test('ok', () => pm.response.to.have.status(200));", "test")},
                {"id": "2", "name": "folder", "variable": [{"key": "folderOnly", "value": "f"}], "item": [
                    {"id": "3", "name": "echo", "request": {"method": "GET", "url": "{{base}}/echo",
                      "header": [{"key": "Authorization", "value": "Bearer {{token}} {{vault:api}}"}]},
                     "event": exec("pm.environment.set('body', pm.response.text()); pm.environment.set('folder', pm.collectionVariables.get('folderOnly'));", "test")}
                ]},
                {"id": "4", "name": "skipped", "request": {"method": "GET", "url": "{{base}}/never"},
                 "event": exec("pm.execution.skipRequest();", "prerequest")}
            ]
        });
        let runs = runs();
        let job = runs
            .start(json!({"collection": collection, "workspace": "w1", "resolvedSecrets": {"api": "secret-value"}}))
            .unwrap();
        while job.running() {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        let view = job.view();
        assert_eq!(view["state"], "completed", "{view}");
        assert_eq!(view["results"].as_array().unwrap().len(), 2);
        let environment = values(&view["environment"]["values"]);
        assert_eq!(environment["token"], "tok-12345");
        assert_eq!(
            environment["body"],
            "auth=Bearer tok-12345 [REDACTED] cookie=session=abc"
        );
        assert_eq!(environment["folder"], "f");
        let collection_variables = values(&view["collectionVariables"]);
        assert_eq!(collection_variables["seen"], 3);
        assert!(collection_variables.get("folderOnly").is_none());
        assert_eq!(view["assertions"][0]["passed"], true);
        assert!(!view.to_string().contains("secret-value"));
        assert_eq!(runs.jars.list("w1").len(), 1);
        assert!(runs.jars.list("w2").is_empty());
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn cookies_survive_a_restart_and_manager_changes_reach_the_next_request() {
        let base = server().await;
        let directory = std::env::temp_dir().join(format!("nexo-jars-{}", uuid::Uuid::new_v4()));
        let open = || {
            Runs::new(
                Arc::new(Jars::new(directory.clone())),
                Context {
                    egress: Policy::AllowAll,
                    loopback_ports: Arc::new(Vec::new),
                    vault: None,
                },
            )
        };
        let get = |path: &str| json!({"workspace": "w1", "request": {"method": "GET", "url": format!("{base}{path}")}});
        let first = open();
        for path in ["/login", "/remember"] {
            first.request(get(path), false).await.unwrap();
        }
        drop(first);

        // A new engine on the same directory sends the session and the persistent cookie.
        let second = open();
        let echoed = second.request(get("/echo"), false).await.unwrap();
        let body = echoed["body"].as_str().unwrap().to_string();
        assert!(body.contains("session=abc"), "{body}");
        assert!(body.contains("remember=yes"), "{body}");

        // What the manager changes is what the next request sends.
        second
            .jars
            .set(
                "w1",
                &json!({"name": "session", "value": "edited", "domain": "127.0.0.1"}),
            )
            .unwrap();
        assert!(second.jars.delete("w1", "127.0.0.1", "/", "remember"));
        let echoed = second.request(get("/echo"), false).await.unwrap();
        assert_eq!(
            echoed["body"], "auth= cookie=session=edited",
            "{}",
            echoed["body"]
        );
        let _ = std::fs::remove_dir_all(directory);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn failures_keep_variables_and_next_request_loops() {
        let base = server().await;
        let runs = runs();
        let collection = json!({"item": [
            {"id": "a", "name": "a", "request": {"method": "GET", "url": format!("{base}/login")},
             "event": exec("const n = (pm.environment.get('n') || 0) + 1; pm.environment.set('n', n); if (n < 3) pm.execution.setNextRequest('a'); else pm.execution.setNextRequest(null);", "test")},
            {"id": "b", "name": "b", "request": {"method": "GET", "url": format!("{base}/login")}}
        ]});
        let result = runs
            .request(json!({"collection": collection}), false)
            .await
            .unwrap();
        assert_eq!(
            values(&result["variables"]["environment"]["values"])["n"],
            3
        );
        let broken = json!({"item": [
            {"id": "a", "name": "a", "request": {"method": "GET", "url": format!("{base}/login")},
             "event": exec("pm.environment.set('before', 1);\nthrow new Error('boom');", "test")}
        ]});
        let job = runs.start(json!({"collection": broken})).unwrap();
        while job.running() {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        let view = job.view();
        assert_eq!(view["state"], "failed");
        assert!(view["error"].as_str().unwrap().contains("boom"));
        assert_eq!(view["results"].as_array().unwrap().len(), 1);
    }
}
