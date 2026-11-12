mod api;
mod sandbox;

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
