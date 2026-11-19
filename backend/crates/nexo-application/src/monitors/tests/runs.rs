//! What a run of a monitor sends, and the history it keeps.
use super::*;

#[tokio::test(start_paused = true)]
async fn a_run_takes_its_folder_environment_and_data_and_cannot_ask() {
    let monitor = document(
        "purge",
        DocumentKind::Monitor,
        json!({
            "collection": "orders", "folder": "admin", "environment": "stage",
            "schedule": {"every": 1, "unit": "minutes"}, "paused": true,
            "iterations": 2, "delay": 50, "data": [{"id": 1}, {"id": 2}],
        }),
    );
    let stage = document(
        "stage",
        DocumentKind::Environment,
        json!({"values": [{"key": "host", "value": "stage.test"}, {"key": " "}],
            "protection": "confirm"}),
    );
    let globals = document(
        "globals",
        DocumentKind::Globals,
        json!({"values": [{"key": "token", "value": "t"}]}),
    );
    let (application, fake, engine) =
        scheduler(Duration::ZERO, vec![collection(), monitor, stage, globals]).await;
    let run = json!({"workspace": "local", "id": "purge"});
    application
        .execute(Operation::MonitorRun, run.clone())
        .await
        .unwrap();
    tokio::time::sleep(Duration::from_secs(2)).await;
    let sent = engine.started.lock().unwrap()[0].clone();
    assert_eq!(sent["collection"]["item"][0]["id"], "admin");
    assert_eq!(sent["collection"]["item"].as_array().unwrap().len(), 1);
    assert_eq!(
        sent["variables"],
        json!([{"key": "host", "value": "stage.test"}])
    );
    assert_eq!(sent["globals"], json!([{"key": "token", "value": "t"}]));
    assert_eq!(sent["environment"], "stage");
    assert_eq!(sent["unattendedEnvironment"], "Doc stage");
    assert_eq!(
        (sent["iterations"].clone(), sent["delay"].clone()),
        (json!(2), json!(50))
    );
    assert_eq!(sent["data"], json!([{"id": 1}, {"id": 2}]));

    // Allowed to send changes there, it does.
    let mut allowed = fake.documents.lock().unwrap().clone();
    for document in &mut allowed {
        if document.id.as_str() == "purge" {
            document.value["allowChanges"] = json!(true);
        }
    }
    *fake.documents.lock().unwrap() = allowed;
    application
        .execute(Operation::MonitorRun, run.clone())
        .await
        .unwrap();
    tokio::time::sleep(Duration::from_secs(2)).await;
    assert!(
        engine.started.lock().unwrap()[1]
            .get("unattendedEnvironment")
            .is_none()
    );

    // Without its folder, it cannot run and says why.
    fake.documents
        .lock()
        .unwrap()
        .retain(|document| document.id.as_str() != "orders");
    fake.documents.lock().unwrap().push(document(
        "orders",
        DocumentKind::Collection,
        json!({"item": []}),
    ));
    application
        .execute(Operation::MonitorRun, run)
        .await
        .unwrap();
    tokio::time::sleep(Duration::from_secs(2)).await;
    let last = &history(&fake, "purge")[0];
    assert_eq!(last["state"], "error");
    assert_eq!(last["error"], "The folder of this monitor no longer exists");
    assert_eq!(engine.started.lock().unwrap().len(), 2);
}

#[tokio::test]
async fn the_history_keeps_the_last_hundred_runs_and_goes_with_its_monitor() {
    let (application, fake) = application();
    let monitor = document(
        "m",
        DocumentKind::Monitor,
        json!({"collection": "orders", "schedule": {"every": 5, "unit": "minutes"}}),
    );
    fake.documents.lock().unwrap().push(monitor.clone());
    for run in 0..crate::MONITOR_HISTORY_LIMIT + 5 {
        application
            .record_run(&monitor, json!({"state": "passed", "startedAt": run}))
            .await
            .unwrap();
    }
    let runs = history(&fake, "m");
    assert_eq!(runs.len(), crate::MONITOR_HISTORY_LIMIT);
    assert_eq!(runs[0]["startedAt"], 104, "newest first");
    application
        .delete_document(&DocumentId::parse("m").unwrap(), 1)
        .await
        .unwrap();
    assert!(
        fake.documents.lock().unwrap().is_empty(),
        "the history went too"
    );
    // Nothing is kept for a monitor deleted while it ran.
    application
        .record_run(&monitor, json!({"state": "passed"}))
        .await
        .unwrap();
    assert!(fake.documents.lock().unwrap().is_empty());
    let answer = application
        .execute(Operation::MonitorStatus, json!({"workspace": "local"}))
        .await
        .unwrap();
    assert_eq!(answer["scheduler"], false);
    let run = json!({"workspace": "local", "id": "m"});
    assert!(
        application
            .execute(Operation::MonitorRun, run)
            .await
            .is_err()
    );
}
