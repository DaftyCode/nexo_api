//! Saved tasks (DB-31): a script run whole on its own sessions with its history, what asks for
//! a confirmation run only when the task authorizes it, a transaction undone at a failure, and
//! tasks of tasks that stop at the first failure.
use crate::testing::{datasources::with_sources, *};

fn document(id: &str, kind: DocumentKind, name: &str, value: Value) -> Document {
    Document {
        id: DocumentId::parse(id).unwrap(),
        workspace_id: WorkspaceId::parse("local").unwrap(),
        kind,
        name: name.into(),
        revision: 1,
        updated_at: 0,
        value,
    }
}

fn setup(
    connection: Value,
    sql: &str,
    tasks: &[(&str, Value)],
) -> (
    Application,
    Arc<Fake>,
    Arc<crate::testing::datasources::FakeSources>,
) {
    let mut value = json!({"host": "db.test"});
    if let (Value::Object(base), Value::Object(more)) = (&mut value, connection) {
        base.extend(more);
    }
    let (application, fake, sources) = with_sources(value);
    let mut documents = fake.documents.lock().unwrap();
    documents.push(document(
        "s1",
        DocumentKind::SqlScript,
        "Script",
        json!({"connectionId": "c1", "sql": sql}),
    ));
    for (id, task) in tasks {
        documents.push(document(id, DocumentKind::DbTask, id, task.clone()));
    }
    drop(documents);
    (application, fake, sources)
}

async fn run(application: &Application, id: &str) -> Value {
    application
        .execute(
            Operation::DbTaskRun,
            json!({"workspace": "local", "id": id}),
        )
        .await
        .unwrap()
}

fn history(fake: &Fake, id: &str) -> Value {
    let documents = fake.documents.lock().unwrap();
    let found = documents
        .iter()
        .find(|document| document.id.as_str() == format!("{id}~history"))
        .unwrap();
    found.value["runs"].clone()
}

#[tokio::test]
async fn a_script_runs_whole_on_its_own_session_and_leaves_its_history() {
    let task = json!({"type": "script", "scripts": ["s1"], "connections": ["c1"]});
    let (application, fake, sources) = setup(
        json!({}),
        "select 1; insert into t values (1); select 2",
        &[("t1", task)],
    );
    let entry = run(&application, "t1").await;
    assert_eq!(entry["state"], "passed", "{entry}");
    assert_eq!(entry["statements"], 3);
    assert_eq!(entry["trigger"], "manual");
    let executed: Vec<String> = sources
        .executed
        .lock()
        .unwrap()
        .iter()
        .map(|(_, r)| r.sql.clone())
        .collect();
    assert_eq!(executed.len(), 3);
    let session = sources.connected.lock().unwrap()[0].0.clone();
    assert!(session.starts_with("task-"), "{session}");
    // Its session is closed at its end.
    assert!(application.sql_sessions.get(&session).is_err());
    assert_eq!(history(&fake, "t1")[0]["state"], "passed");
}

#[tokio::test]
async fn what_asks_for_a_confirmation_runs_only_when_the_task_authorizes_it() {
    let refused = json!({"type": "script", "scripts": ["s1"], "connections": ["c1"]});
    let allowed = json!({"type": "script", "scripts": ["s1"], "connections": ["c1"],
        "authorize": {"everyRow": true, "writes": true}});
    let (application, _, sources) = setup(
        json!({"type": "production"}),
        "delete from orders",
        &[("refused", refused), ("allowed", allowed)],
    );
    let entry = run(&application, "refused").await;
    assert_eq!(entry["state"], "failed");
    assert!(
        entry["error"]
            .as_str()
            .unwrap()
            .contains("does not authorize statements on every row"),
        "{entry}"
    );
    assert_eq!(entry["statement"], "delete from orders");
    assert!(sources.executed.lock().unwrap().is_empty());
    let entry = run(&application, "allowed").await;
    assert_eq!(entry["state"], "passed", "{entry}");
    assert_eq!(sources.executed.lock().unwrap().len(), 1);
    // A DROP is authorized with the name the rules ask for.
    let (application, _, sources) = setup(
        json!({}),
        "drop table orders",
        &[(
            "drop",
            json!({"type": "script", "scripts": ["s1"], "connections": ["c1"], "authorize": {"drop": true}}),
        )],
    );
    assert_eq!(run(&application, "drop").await["state"], "passed");
    assert_eq!(sources.executed.lock().unwrap().len(), 1);
}

#[tokio::test]
async fn a_failure_undoes_the_transaction_and_stops_unless_the_task_goes_on() {
    let stops =
        json!({"type": "script", "scripts": ["s1"], "connections": ["c1"], "transaction": true});
    let (application, _, sources) = setup(
        json!({}),
        "insert into t values (1); fail here; select 3",
        &[("t", stops)],
    );
    let entry = run(&application, "t").await;
    assert_eq!(entry["state"], "failed");
    assert_eq!(entry["statements"], 1);
    assert_eq!(
        *sources.transactions.lock().unwrap(),
        ["manual", "rollback"]
    );
    // Tasks of tasks: the second one never runs after the first fails.
    let composite = json!({"type": "composite", "tasks": ["t", "next"], "onError": "stop"});
    let next = json!({"type": "script", "scripts": ["s1"], "connections": ["c1"]});
    let (application, _, sources) = setup(
        json!({}),
        "fail here",
        &[
            (
                "t",
                json!({"type": "script", "scripts": ["s1"], "connections": ["c1"]}),
            ),
            ("next", next),
            ("all", composite),
        ],
    );
    let entry = run(&application, "all").await;
    assert_eq!(entry["state"], "failed");
    assert!(
        entry["error"].as_str().unwrap().starts_with("t: "),
        "{entry}"
    );
    assert_eq!(sources.executed.lock().unwrap().len(), 1);
}

#[tokio::test]
async fn a_connection_that_asks_for_its_password_cannot_run_in_a_task() {
    let task = json!({"type": "script", "scripts": ["s1"], "connections": ["c1"]});
    let (application, _, _) = setup(
        json!({"askPassword": true, "password": null}),
        "select 1",
        &[("t", task)],
    );
    let entry = run(&application, "t").await;
    assert_eq!(entry["state"], "failed");
    assert!(
        entry["error"]
            .as_str()
            .unwrap()
            .contains("asks for its password each time"),
        "{entry}"
    );
    let missing = application
        .execute(
            Operation::DbTaskRun,
            json!({"workspace": "local", "id": "nothing"}),
        )
        .await;
    assert!(missing.is_err());
}
