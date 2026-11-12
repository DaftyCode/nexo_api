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
            databases: Default::default(),
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
    assert_eq!(view["assertions"][0]["request"], "login");
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
                databases: Default::default(),
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
