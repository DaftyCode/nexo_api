//! Pre-request and test scripts, evaluated with QuickJS.
//!
//! Each execution gets its own runtime and context with memory and time limits. The context
//! has no host functions: scripts exchange JSON strings with the engine through the
//! `__nexo` object installed by `bootstrap.js`, and requests made with `pm.sendRequest` are
//! queued for the engine to send. Code generation from strings is disabled.
use nexo_domain::{Error, Result};
use rquickjs::{Context, Runtime};
use serde_json::Value;
use std::{
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant},
};

const BOOTSTRAP: &str = include_str!("bootstrap.js");
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
}
impl ScriptSession {
    pub fn new(seed: &Value, cancelled: Arc<AtomicBool>) -> Result<Self> {
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
        };
        session.evaluate(&format!(
            "{BOOTSTRAP}({seed})",
            seed = serde_json::to_string(seed).map_err(infrastructure)?
        ))?;
        session.evaluate(HARDEN)?;
        Ok(session)
    }

    /// Evaluates source with the time limit and runs the promise jobs it queued.
    fn evaluate(&self, source: &str) -> Result<Option<String>> {
        *self.deadline.lock().unwrap_or_else(|e| e.into_inner()) =
            Some(Instant::now() + SCRIPT_TIMEOUT);
        let result = self.context.with(|ctx| -> Result<Option<String>> {
            match ctx.eval::<rquickjs::Value, _>(source) {
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
        self.json(&format!(
            "__nexo.replace({})",
            serde_json::to_string(value).map_err(infrastructure)?
        ))
    }
    /// Evaluates scripts. With a response, `pm.response` is available to them.
    pub fn run(&self, sources: &[String], response: Option<&Value>) -> Result<()> {
        if let Some(response) = response {
            self.evaluate(&format!(
                "__nexo.response({})",
                serde_json::to_string(response).map_err(infrastructure)?
            ))?;
        }
        for source in sources {
            self.evaluate(source)?;
        }
        Ok(())
    }
    /// Requests queued by `pm.sendRequest` since the last call.
    pub fn take_queue(&self) -> Result<Vec<(String, Value)>> {
        let queue = self.json("__nexo.queue()")?;
        Ok(queue
            .as_array()
            .map(|items| {
                items
                    .iter()
                    .map(|entry| {
                        (
                            entry["id"].as_str().unwrap_or_default().to_string(),
                            entry["request"].clone(),
                        )
                    })
                    .collect()
            })
            .unwrap_or_default())
    }
    pub fn deliver(&self, id: &str, result: Option<&Value>, error: Option<&str>) -> Result<()> {
        self.evaluate(&format!(
            "__nexo.deliver({},{},{})",
            serde_json::to_string(id).map_err(infrastructure)?,
            serde_json::to_string(&result).map_err(infrastructure)?,
            serde_json::to_string(&error).map_err(infrastructure)?
        ))?;
        Ok(())
    }
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
mod tests {
    use super::*;
    use serde_json::json;
    fn session() -> ScriptSession {
        ScriptSession::new(
            &json!({
                "environment": {"base": "http://x"}, "globals": {}, "local": {}, "collection": {},
                "data": {}, "secrets": {"vault:token": "s3cret"},
                "request": {"method": "GET", "url": "{{base}}/a", "header": []},
                "iteration": 0, "iterationCount": 1, "requestName": "r", "requestId": "1", "uuid": "u"
            }),
            Arc::new(AtomicBool::new(false)),
        )
        .unwrap()
    }
    #[test]
    fn scripts_set_variables_and_assertions() {
        let session = session();
        session
            .run(&["pm.environment.set('x', 1); pm.test('ok', () => pm.expect(1).to.equal(1)); pm.test('bad', () => pm.expect(1).to.equal(2));".into()], None)
            .unwrap();
        let state = session.snapshot().unwrap();
        assert_eq!(state["environment"]["x"], 1);
        assert_eq!(state["assertions"][0]["passed"], true);
        assert_eq!(state["assertions"][1]["passed"], false);
        assert_eq!(
            session
                .replace(&json!({"url": "{{base}}/{{vault:token}}"}))
                .unwrap()["url"],
            "http://x/s3cret"
        );
    }
    #[test]
    fn scripts_cannot_read_secrets_or_generate_code() {
        let session = session();
        session
            .run(&["pm.environment.set('leak', String(pm.variables.get('vault:token'))); pm.environment.set('replaced', pm.variables.replaceIn('{{vault:token}}'));".into()], None)
            .unwrap();
        let state = session.snapshot().unwrap();
        assert_eq!(state["environment"]["leak"], "undefined");
        assert_eq!(state["environment"]["replaced"], "{{vault:token}}");
        assert!(state.get("secrets").is_none());
        for attempt in [
            "eval('1')",
            "new Function('return 1')",
            "(function(){}).constructor('return 1')()",
            "(async function(){}).constructor('return 1')",
        ] {
            assert!(session.run(&[attempt.into()], None).is_err(), "{attempt}");
        }
    }
    #[test]
    fn infinite_loops_stop_at_the_time_limit() {
        let session = session();
        let started = Instant::now();
        let error = session.run(&["while (true) {}".into()], None).unwrap_err();
        assert!(error.to_string().contains("5 second"), "{error}");
        assert!(started.elapsed() < Duration::from_secs(8));
    }
    #[test]
    fn send_request_callbacks_are_delivered() {
        let session = session();
        session
            .run(&["pm.test('async', async () => { const r = await pm.sendRequest('http://y'); pm.environment.set('code', r.code); });".into()], None)
            .unwrap();
        let queue = session.take_queue().unwrap();
        assert_eq!(queue.len(), 1);
        assert_eq!(queue[0].1["url"], "http://y");
        session
            .deliver(
                &queue[0].0,
                Some(&json!({"status": 201, "body": "", "headers": []})),
                None,
            )
            .unwrap();
        assert_eq!(session.snapshot().unwrap()["environment"]["code"], 201);
    }
}
