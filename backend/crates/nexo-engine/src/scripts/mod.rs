//! Pre-request and test scripts, evaluated with QuickJS.
//!
//! Each execution gets its own runtime and context with memory and time limits. The context
//! has no host functions: scripts exchange JSON strings with the engine through the
//! `__nexo` object installed by the `bootstrap/` script, requests made with
//! `pm.sendRequest` are queued for the engine to send, and `nx.mongo` calls for the
//! application to answer. Code generation from strings is
//! disabled. Vault secrets and OAuth 2.0 tokens never enter the context: the host fills them
//! into the request.
use nexo_domain::{Error, Result};
use rquickjs::{Context, Runtime};
use serde_json::{Map, Value};
use std::{
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant},
};

/// The script API, one function the engine calls with the seed. Its parts are in order.
const BOOTSTRAP: &str = concat!(
    include_str!("bootstrap/01-state.js"),
    include_str!("bootstrap/02-expect.js"),
    include_str!("bootstrap/03-variables.js"),
    include_str!("bootstrap/04-api.js"),
    include_str!("bootstrap/05-mongo.js"),
    include_str!("bootstrap/06-host.js"),
);
mod queue;

const SCRIPT_TIMEOUT: Duration = Duration::from_secs(5);
const MEMORY_LIMIT: usize = 128 * 1024 * 1024;
/// Removes every way to compile code from strings inside the sandbox.
const HARDEN: &str = r#"
(() => {
  const blocked = () => { throw new EvalError('Code generation from strings is disabled'); };
  const constructors = [
    Function,
    Object.getPrototypeOf(function* () {}).constructor,
    Object.getPrototypeOf(async function () {}).constructor,
    Object.getPrototypeOf(async function* () {}).constructor,
  ];
  for (const constructor of constructors)
    Object.defineProperty(constructor.prototype, 'constructor', { value: blocked, writable: false, configurable: false });
  Object.defineProperty(globalThis, 'Function', { value: blocked, writable: false, configurable: false });
  Object.defineProperty(globalThis, 'eval', { value: blocked, writable: false, configurable: false });
})();
"#;

pub struct ScriptSession {
    runtime: Runtime,
    context: Context,
    deadline: Arc<Mutex<Option<Instant>>>,
    cancelled: Arc<AtomicBool>,
    /// Vault secrets (`vault:<name>`) and OAuth 2.0 token variables. They stay on the host:
    /// the context never receives them, so no script or overridden built-in can read them.
    secrets: Map<String, Value>,
}
impl ScriptSession {
    /// Starts a session from the seed state. Its `secrets` are kept out of the context and
    /// filled into requests by [`ScriptSession::replace`] on the host.
    pub fn new(seed: &Value, cancelled: Arc<AtomicBool>) -> Result<Self> {
        let mut seed = seed.clone();
        let secrets = match seed.as_object_mut().and_then(|seed| seed.remove("secrets")) {
            Some(Value::Object(secrets)) => secrets,
            _ => Map::new(),
        };
        let runtime = Runtime::new().map_err(infrastructure)?;
        runtime.set_memory_limit(MEMORY_LIMIT);
        runtime.set_max_stack_size(1024 * 1024);
        let deadline: Arc<Mutex<Option<Instant>>> = Arc::new(Mutex::new(None));
        let (limit, stop) = (deadline.clone(), cancelled.clone());
        runtime.set_interrupt_handler(Some(Box::new(move || {
            stop.load(Ordering::Relaxed)
                || limit
                    .lock()
                    .ok()
                    .and_then(|deadline| *deadline)
                    .is_some_and(|deadline| Instant::now() > deadline)
        })));
        let context = Context::full(&runtime).map_err(infrastructure)?;
        let session = Self {
            runtime,
            context,
            deadline,
            cancelled,
            secrets,
        };
        session.evaluate(&format!(
            "{BOOTSTRAP}({seed})",
            seed = serde_json::to_string(&seed).map_err(infrastructure)?
        ))?;
        session.evaluate(HARDEN)?;
        Ok(session)
    }

    /// Evaluates source with the time limit and runs the promise jobs it queued.
    fn evaluate(&self, source: &str) -> Result<Option<String>> {
        self.evaluate_keeping(source, None)
    }
    /// Evaluates source and keeps its completion value in the global `name`: what the last
    /// statement of a shell command gave.
    pub(crate) fn evaluate_into(&self, source: &str, name: &str) -> Result<()> {
        self.evaluate_keeping(source, Some(name)).map(|_| ())
    }
    fn evaluate_keeping(&self, source: &str, keep: Option<&str>) -> Result<Option<String>> {
        *self.deadline.lock().unwrap_or_else(|e| e.into_inner()) =
            Some(Instant::now() + SCRIPT_TIMEOUT);
        let result = self.context.with(|ctx| -> Result<Option<String>> {
            match ctx.eval::<rquickjs::Value, _>(source) {
                Ok(value) if keep.is_some() => {
                    ctx.globals()
                        .set(keep.unwrap_or_default(), value)
                        .map_err(infrastructure)?;
                    Ok(None)
                }
                Ok(value) => Ok(value.as_string().and_then(|text| text.to_string().ok())),
                Err(rquickjs::Error::Exception) => {
                    Err(Error::Validation(exception_message(&ctx.catch())))
                }
                Err(error) => Err(Error::Validation(error.to_string())),
            }
        });
        let pending = self.drain();
        *self.deadline.lock().unwrap_or_else(|e| e.into_inner()) = None;
        if self.cancelled.load(Ordering::Relaxed) {
            return Err(Error::Validation("Execution cancelled".into()));
        }
        match result {
            Err(Error::Validation(message)) if message.contains("interrupted") => Err(
                Error::Validation("Script exceeded the 5 second limit".into()),
            ),
            other => {
                pending?;
                other
            }
        }
    }
    /// Runs queued promise reactions (async tests, sendRequest callbacks).
    fn drain(&self) -> Result<()> {
        while self.runtime.is_job_pending() {
            if let Err(error) = self.runtime.execute_pending_job() {
                let message = error.0.with(|ctx| exception_message(&ctx.catch()));
                return Err(Error::Validation(message));
            }
        }
        Ok(())
    }
    fn json(&self, source: &str) -> Result<Value> {
        let text = self
            .evaluate(source)?
            .ok_or_else(|| Error::Infrastructure("Script bridge returned no data".into()))?;
        serde_json::from_str(&text).map_err(infrastructure)
    }

    pub fn snapshot(&self) -> Result<Value> {
        self.json("__nexo.snapshot()")
    }
    /// Replaces `{{variables}}`, including vault secrets, in a request for sending.
    pub fn replace(&self, value: &Value) -> Result<Value> {
        Ok(self.fill_secrets(&self.replace_variables(value)?))
    }
    /// Replaces the script variables in the context. Secret references are left as written,
    /// for [`ScriptSession::fill_secrets`]: where they are is where the secrets will travel.
    pub fn replace_variables(&self, value: &Value) -> Result<Value> {
        self.json(&format!(
            "__nexo.replace({})",
            serde_json::to_string(value).map_err(infrastructure)?
        ))
    }
    /// Fills the secret references (`{{vault:name}}`, `{{$oauth2.name.access_token}}`) on
    /// the host, in one pass: a secret's value is never scanned for more references.
    pub fn fill_secrets(&self, value: &Value) -> Value {
        match value {
            Value::String(text) => Value::String(fill(text, &self.secrets)),
            Value::Array(items) => {
                Value::Array(items.iter().map(|item| self.fill_secrets(item)).collect())
            }
            Value::Object(map) => Value::Object(
                map.iter()
                    .map(|(key, item)| (key.clone(), self.fill_secrets(item)))
                    .collect(),
            ),
            other => other.clone(),
        }
    }
    /// Evaluates scripts. With a response, `pm.response` is available to them.
    pub fn run(&self, sources: &[String], response: Option<&Value>) -> Result<()> {
        if let Some(response) = response {
            self.evaluate(&format!(
                "__nexo.response({})",
                serde_json::to_string(&script_response(response)).map_err(infrastructure)?
            ))?;
        }
        for source in sources {
            self.evaluate(source)?;
        }
        Ok(())
    }
}

/// What `pm.response` is built from. The result of a send also holds the request as sent,
/// with its secrets filled in, and the final URL; neither enters the context. Every field
/// is present, so reading one never reaches a getter a script put on `Object.prototype`.
fn script_response(result: &Value) -> Value {
    let field = |name: &str, default: Value| match result.get(name) {
        Some(value) if !value.is_null() => value.clone(),
        _ => default,
    };
    serde_json::json!({
        "status": field("status", Value::from(0)),
        "statusText": field("statusText", Value::from("")),
        "time": field("time", Value::from(0)),
        "size": field("size", Value::from(0)),
        "headers": field("headers", Value::Array(Vec::new())),
        "body": field("body", Value::from("")),
        "cookies": field("cookies", Value::Array(Vec::new())),
    })
}

/// Replaces `{{ name }}` with the secret of that name, with the runtime's syntax: no braces
/// inside, surrounding spaces ignored. Unknown names are left as written.
pub(crate) fn fill(text: &str, secrets: &Map<String, Value>) -> String {
    if secrets.is_empty() || !text.contains("{{") {
        return text.to_string();
    }
    let mut output = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(start) = rest.find("{{") {
        let inner = &rest[start + 2..];
        let length = inner.find(['{', '}']).unwrap_or(inner.len());
        if length == 0 || !inner[length..].starts_with("}}") {
            // Not a reference here; it may start one character later (`{{{name}}`).
            output.push_str(&rest[..=start]);
            rest = &rest[start + 1..];
            continue;
        }
        let end = start + 2 + length + 2;
        output.push_str(&rest[..start]);
        match secrets.get(inner[..length].trim()) {
            Some(Value::String(secret)) => output.push_str(secret),
            Some(secret) if !secret.is_null() => output.push_str(&secret.to_string()),
            _ => output.push_str(&rest[start..end]),
        }
        rest = &rest[end..];
    }
    output.push_str(rest);
    output
}

fn exception_message(value: &rquickjs::Value) -> String {
    if let Some(object) = value.as_object()
        && let Ok(message) = object.get::<_, String>("message")
    {
        let name = object.get::<_, String>("name").unwrap_or_default();
        return if name.is_empty() || name == "Error" {
            message
        } else {
            format!("{name}: {message}")
        };
    }
    value
        .as_string()
        .and_then(|text| text.to_string().ok())
        .unwrap_or_else(|| "Script error".into())
}
fn infrastructure(error: impl std::fmt::Display) -> Error {
    Error::Infrastructure(error.to_string())
}

#[cfg(test)]
mod tests;
