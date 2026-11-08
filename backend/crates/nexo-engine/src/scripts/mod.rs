//! Pre-request and test scripts, evaluated with QuickJS.
//!
//! Each execution gets its own runtime and context with memory and time limits. The context
//! has no host functions: scripts exchange JSON strings with the engine through the
//! `__nexo` object installed by `bootstrap.js`, and requests made with `pm.sendRequest` are
//! queued for the engine to send. Code generation from strings is disabled. Vault secrets
//! and OAuth 2.0 tokens never enter the context: the host fills them into the request.
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
            serde_json::to_string(&result.map(script_response)).map_err(infrastructure)?,
            serde_json::to_string(&error).map_err(infrastructure)?
        ))?;
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
fn fill(text: &str, secrets: &Map<String, Value>) -> String {
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
    /// The engine substitutes vault secrets after the pre-request script. Overridden
    /// built-ins must not hand the secrets to a later script in the same session.
    #[test]
    fn overridden_builtins_cannot_capture_secrets_during_substitution() {
        for trap in [
            "const own = Object.hasOwn; Object.hasOwn = (o, k) => { globalThis.seen.push(JSON.stringify(o)); return own(o, k); };",
            "const re = String.prototype.replace; String.prototype.replace = function (p, f) { if (typeof f === 'function') globalThis.seen.push(f('{{vault:token}}', 'vault:token')); return re.call(this, p, f); };",
            "const sr = RegExp.prototype[Symbol.replace]; RegExp.prototype[Symbol.replace] = function (s, f) { if (typeof f === 'function') globalThis.seen.push(f('{{vault:token}}', 'vault:token')); return sr.call(this, s, f); };",
            "const st = String; globalThis.String = function (v) { globalThis.seen.push(v); return st(v); };",
        ] {
            let session = session();
            session
                .run(&[format!("globalThis.seen = []; {trap}")], None)
                .unwrap();
            let sent = session
                .replace(&json!({"url": "{{base}}/{{vault:token}}"}))
                .unwrap();
            assert_eq!(sent["url"], "http://x/s3cret", "{trap}");
            session
                .run(
                    &["pm.environment.set('leak', JSON.stringify(globalThis.seen));".into()],
                    None,
                )
                .unwrap();
            let leak = session.snapshot().unwrap()["environment"]["leak"].to_string();
            assert!(!leak.contains("s3cret"), "{trap} leaked {leak}");
        }
    }
    #[test]
    fn test_scripts_never_receive_the_request_as_sent() {
        let session = session();
        session
            .run(
                &[r#"
                globalThis.seen = [];
                for (const name of ['cookies', 'url', 'request', 'bodyEncoding', 'warnings'])
                    Object.defineProperty(Object.prototype, name, {
                        get() { globalThis.seen.push(JSON.stringify(this)); return undefined; },
                        configurable: true,
                    });
            "#
                .into()],
                None,
            )
            .unwrap();
        let sent = json!({
            "url": "http://x/?key=s3cret", "status": 200, "statusText": "OK", "body": "{}",
            "headers": [], "size": 2, "time": 1, "request": {"url": "http://x/?key=s3cret"}
        });
        session
            .run(
                &["pm.test('status', () => pm.response.to.have.status(200)); pm.response.cookies.toObject(); pm.sendRequest('http://y', (error, response) => response.cookies.toObject());".into()],
                Some(&sent),
            )
            .unwrap();
        let queue = session.take_queue().unwrap();
        session.deliver(&queue[0].0, Some(&sent), None).unwrap();
        session
            .run(
                &["pm.environment.set('seen', JSON.stringify(globalThis.seen));".into()],
                None,
            )
            .unwrap();
        let state = session.snapshot().unwrap();
        assert_eq!(state["assertions"][0]["passed"], true);
        assert!(!state.to_string().contains("s3cret"), "{state}");
    }
    #[test]
    fn secrets_are_filled_on_the_host_in_one_pass() {
        let secrets = Map::from_iter([
            ("vault:token".to_string(), json!("s3cret")),
            ("vault:nested".to_string(), json!("{{vault:token}}")),
            ("$oauth2.api.access_token".to_string(), json!("tok")),
        ]);
        for (text, filled) in [
            ("{{vault:token}}", "s3cret"),
            ("a {{ vault:token }} b", "a s3cret b"),
            ("{{{vault:token}}}", "{s3cret}"),
            ("{{vault:nested}}", "{{vault:token}}"),
            ("{{$oauth2.api.access_token}}", "tok"),
            (
                "{{vault:missing}} {{}} {{vault:to{ken}}",
                "{{vault:missing}} {{}} {{vault:to{ken}}",
            ),
            ("no references", "no references"),
            ("{{vault:token", "{{vault:token"),
        ] {
            assert_eq!(fill(text, &secrets), filled, "{text}");
        }
    }
    #[test]
    fn script_requests_never_carry_secrets() {
        let session = session();
        session
            .run(&["pm.sendRequest({ url: 'http://y/{{vault:token}}', header: [{ key: 'X', value: '{{base}}' }] });".into()], None)
            .unwrap();
        let queue = session.take_queue().unwrap();
        assert_eq!(queue[0].1["url"], "http://y/{{vault:token}}");
        assert_eq!(queue[0].1["header"][0]["value"], "http://x");
    }
    #[test]
    fn a_variable_named_like_a_secret_does_not_shadow_it() {
        let session = session();
        session
            .run(&["pm.environment.set('vault:token', 'fake');".into()], None)
            .unwrap();
        assert_eq!(
            session.replace(&json!("{{vault:token}}")).unwrap(),
            "s3cret"
        );
    }
    #[test]
    fn deep_recursion_fails_without_bringing_down_the_session() {
        let session = session();
        let error = session
            .run(
                &["const down = (n) => down(n + 1) + 1; down(0);".into()],
                None,
            )
            .unwrap_err();
        assert!(error.to_string().contains("stack"), "{error}");
        session
            .run(&["pm.environment.set('after', 'ok');".into()], None)
            .unwrap();
        assert_eq!(session.snapshot().unwrap()["environment"]["after"], "ok");
    }
    #[test]
    fn huge_allocations_stop_at_the_memory_limit() {
        let session = session();
        let started = Instant::now();
        for attempt in [
            "const chunks = []; while (true) chunks.push('x'.repeat(1 << 20) + chunks.length);",
            "'x'.repeat(1 << 29)",
            "new ArrayBuffer(512 * 1024 * 1024)",
        ] {
            let error = session.run(&[attempt.into()], None).unwrap_err();
            assert!(
                error.to_string().to_lowercase().contains("memory")
                    || error.to_string().contains("RangeError"),
                "{attempt}: {error}"
            );
        }
        assert!(started.elapsed() < Duration::from_secs(8));
    }
    #[test]
    fn polluted_prototypes_do_not_reach_the_next_execution() {
        let polluted = session();
        polluted
            .run(&["Object.prototype.polluted = 'yes'; Array.prototype.map = () => []; JSON.parse = () => ({}); globalThis.leftover = 1;".into()], None)
            .unwrap();
        // The host keeps working with the polluted context it owns.
        polluted
            .run(&["pm.environment.set('mine', 1);".into()], None)
            .unwrap();
        assert_eq!(polluted.snapshot().unwrap()["environment"]["mine"], 1);
        let next = session();
        next.run(&["pm.environment.set('clean', [typeof ({}).polluted, [1].map((n) => n * 2)[0], JSON.parse('{\"a\":1}').a, typeof leftover].join());".into()], None)
            .unwrap();
        assert_eq!(
            next.snapshot().unwrap()["environment"]["clean"],
            "undefined,2,1,undefined"
        );
    }
    #[test]
    fn scripts_reach_nothing_of_the_host() {
        let session = session();
        session
            .run(&[r#"
                const kinds = ['require', 'process', 'std', 'os', 'module', 'exports', 'Deno', 'Bun',
                    'fetch', 'XMLHttpRequest', 'setTimeout', 'WebAssembly']
                    .map((name) => `${name}:${typeof globalThis[name]}`);
                pm.environment.set('kinds', kinds.join());
                import('os').then(() => pm.environment.set('imported', true),
                    (error) => pm.environment.set('importError', String(error)));
                try { globalThis.__nexo = { snapshot: () => '"forged"' }; } catch {}
                try { delete globalThis.__nexo; } catch {}
                try { __nexo.snapshot = () => '"forged"'; } catch {}
            "#.into()], None)
            .unwrap();
        let state = session.snapshot().unwrap();
        let environment = &state["environment"];
        for kind in environment["kinds"].as_str().unwrap().split(',') {
            assert!(kind.ends_with(":undefined"), "{kind} is reachable");
        }
        assert!(environment.get("imported").is_none());
        assert!(environment["importError"].is_string(), "{environment}");
        assert!(session.run(&["import fs from 'fs';".into()], None).is_err());
    }
    #[test]
    fn console_output_is_bounded() {
        let session = session();
        session
            .run(
                &[r#"
                console.log('x'.repeat(100000), 'second');
                console.log(...Array.from({ length: 50000 }, () => ''));
                const cycle = {}; cycle.self = cycle;
                console.log(cycle);
                console.warn(undefined, { toJSON() { throw new Error('no'); } });
                for (let i = 0; i < 2000; i++) console.info(i);
            "#
                .into()],
                None,
            )
            .unwrap();
        let logs = session.snapshot().unwrap()["logs"].clone();
        let logs = logs.as_array().unwrap();
        assert_eq!(logs.len(), 1000);
        let first = logs[0]["values"].as_array().unwrap();
        assert_eq!(first.len(), 1, "the second value has no room left");
        let text = first[0].as_str().unwrap();
        assert!(text.starts_with(&"x".repeat(16_384)));
        assert!(
            text.ends_with("… [83616 more characters]"),
            "{}",
            &text[16_384..]
        );
        assert_eq!(logs[1]["values"].as_array().unwrap().len(), 16_384);
        assert_eq!(logs[2]["values"][0], "[object Object]");
        assert_eq!(logs[3]["values"], json!(["undefined", "[object Object]"]));
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
