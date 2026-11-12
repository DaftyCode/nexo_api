//! The limits of the sandbox: recursion, memory, prototypes, host access, console and time.
use super::super::*;
use super::*;

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
