//! When monitors run: on their schedule, never overlapping, or by hand.
use super::*;

#[tokio::test(start_paused = true)]
async fn a_monitor_every_minute_runs_keeps_its_history_and_never_overlaps() {
    let monitor = document(
        "nightly",
        DocumentKind::Monitor,
        json!({"collection": "orders", "schedule": {"every": 1, "unit": "minutes"}, "notify": true}),
    );
    // Each run takes a minute and a half: the minute after it starts finds it running.
    let (_application, fake, engine) =
        scheduler(Duration::from_secs(90), vec![collection(), monitor]).await;
    tokio::time::sleep(Duration::from_secs(5 * 60)).await;

    assert_eq!(
        engine.started.lock().unwrap().len(),
        3,
        "at :11, :13 and :15"
    );
    let runs = history(&fake, "nightly");
    let states: Vec<_> = runs.iter().map(|run| run["state"].clone()).collect();
    assert_eq!(states, ["failed", "skipped", "failed", "skipped"]);
    let run = &runs[0];
    assert_eq!(run["trigger"], "schedule");
    assert_eq!(run["requests"], 1);
    assert_eq!(run["passedAssertions"], 1);
    assert_eq!(run["failedAssertions"], 1);
    assert_eq!(
        run["failures"],
        json!([{"request": "List orders", "assertion": "is fast", "error": "took 3 s"}])
    );
    assert_eq!(run["duration"], 90_000, "polled every second");
    assert_eq!(runs[1]["error"], "The previous run had not finished");
    let first = engine.started.lock().unwrap()[0].clone();
    assert_eq!(first["workspace"], "local");
    assert_eq!(first["collection"]["item"].as_array().unwrap().len(), 2);
    assert_eq!(first["iterations"], 1);
}

#[tokio::test(start_paused = true)]
async fn status_tells_the_next_run_and_a_monitor_runs_now_once_at_a_time() {
    let monitor = document(
        "quarter",
        DocumentKind::Monitor,
        json!({"collection": "orders", "schedule": {"every": 15, "unit": "minutes"}}),
    );
    let paused = document(
        "paused",
        DocumentKind::Monitor,
        json!({"collection": "orders", "schedule": {"every": 1, "unit": "minutes"}, "paused": true}),
    );
    let (application, fake, engine) =
        scheduler(Duration::from_secs(30), vec![collection(), monitor, paused]).await;
    let ask = |after: u64| {
        application.execute(
            Operation::MonitorStatus,
            json!({"workspace": "local", "after": after}),
        )
    };
    let answer = ask(0).await.unwrap();
    assert_eq!(answer["scheduler"], true);
    assert_eq!(status(&answer, "quarter")["next"], (START + 5) * 60_000);
    assert_eq!(status(&answer, "paused")["next"], Value::Null);

    let run = json!({"workspace": "local", "id": "paused"});
    application
        .execute(Operation::MonitorRun, run.clone())
        .await
        .unwrap();
    assert_eq!(status(&ask(0).await.unwrap(), "paused")["running"], true);
    let again = application.execute(Operation::MonitorRun, run).await;
    assert!(again.unwrap_err().to_string().contains("still running"));
    tokio::time::sleep(Duration::from_secs(40)).await;

    let answer = ask(0).await.unwrap();
    assert_eq!(status(&answer, "paused")["running"], false);
    assert_eq!(
        engine.started.lock().unwrap().len(),
        1,
        "paused ones only run by hand"
    );
    assert_eq!(history(&fake, "paused")[0]["trigger"], "manual");
    let finished = answer["finished"].as_array().unwrap();
    assert_eq!(finished.len(), 1);
    assert_eq!(finished[0]["monitor"], "paused");
    assert_eq!(finished[0]["state"], "failed");
    assert_eq!(finished[0]["notify"], false);
    let sequence = answer["sequence"].as_u64().unwrap();
    assert!(
        ask(sequence).await.unwrap()["finished"]
            .as_array()
            .unwrap()
            .is_empty()
    );

    let other = json!({"workspace": "local", "id": "orders"});
    assert!(
        application
            .execute(Operation::MonitorRun, other)
            .await
            .is_err()
    );
}

#[tokio::test(start_paused = true)]
async fn a_database_task_runs_on_its_schedule_and_its_failures_are_told() {
    use crate::testing::datasources::FakeSources;
    let fake = Arc::new(Fake::default());
    fake.workspaces.lock().unwrap().push(workspace("local"));
    let connection =
        json!({"driver": "postgres", "host": "db.test", "database": "shop", "user": "ana"});
    fake.documents.lock().unwrap().extend([
        document("c1", DocumentKind::Connection, connection),
        document(
            "s1",
            DocumentKind::SqlScript,
            json!({"connectionId": "c1", "sql": "fail here"}),
        ),
        document(
            "nightly-task",
            DocumentKind::DbTask,
            json!({"type": "script", "scripts": ["s1"], "connections": ["c1"],
                   "schedule": {"every": 1, "unit": "minutes"}}),
        ),
    ]);
    let sources = Arc::new(FakeSources::default());
    let application = Arc::new(
        Application::new(
            fake.clone(),
            Arc::new(Engine::default()),
            fake.clone(),
            fake.clone(),
            fake.clone(),
        )
        .with_datasources(sources.clone()),
    );
    let clock = Arc::new(Paused {
        base: START * 60_000 + 30_000,
        since: Instant::now(),
    });
    tokio::spawn(application.clone().run_monitors(clock));
    tokio::task::yield_now().await;
    tokio::time::sleep(Duration::from_secs(3 * 60)).await;
    let runs = history(&fake, "nightly-task");
    assert_eq!(runs.len(), 3, "{runs:?}");
    assert!(
        runs.iter()
            .all(|run| run["state"] == "failed" && run["trigger"] == "schedule")
    );
    let status = application
        .execute(
            Operation::MonitorStatus,
            json!({"workspace": "local", "after": 0}),
        )
        .await
        .unwrap();
    assert_eq!(status["tasks"][0]["id"], "nightly-task");
    assert!(status["tasks"][0]["next"].is_number());
    let finished = status["finished"].as_array().unwrap();
    assert_eq!(finished[0]["kind"], "db-task");
    assert_eq!(finished[0]["state"], "failed");
    // A task always tells its failures, with nothing to tick.
    assert_eq!(finished[0]["notify"], true);
}
