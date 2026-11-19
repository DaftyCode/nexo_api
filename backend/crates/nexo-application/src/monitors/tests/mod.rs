//! The scheduler with a paused clock: tokio moves the time forward whenever every task waits.
//! Here the fakes; the tests are in `schedule` (when monitors run) and `runs` (what a run
//! sends and keeps).
pub(super) use crate::{ports::Clock, testing::*};
use nexo_domain::monitor::LocalTime;
pub(super) use std::{collections::HashMap, time::Duration};
use tokio::time::Instant;

/// Ten minutes past an hour and thirty seconds, in minutes since the epoch.
pub(super) const START: i64 = 29_000_000 * 60 + 10;

/// A clock without offsets that moves with tokio's paused time.
struct Paused {
    base: i64,
    since: Instant,
}
impl Clock for Paused {
    fn now(&self) -> i64 {
        self.base + self.since.elapsed().as_millis() as i64
    }
    fn local(&self, millis: i64) -> LocalTime {
        let minute = millis.div_euclid(60_000);
        LocalTime {
            minute: minute.rem_euclid(60) as u32,
            hour: minute.div_euclid(60).rem_euclid(24) as u32,
            day: 19,
            month: 11,
            weekday: 4,
        }
    }
}

/// An engine whose runs take `length` and fail one assertion of two.
#[derive(Default)]
pub(super) struct Engine {
    pub(super) started: Mutex<Vec<Value>>,
    runs: Mutex<HashMap<String, Instant>>,
    length: Duration,
}
#[async_trait::async_trait]
impl ExecutionGateway for Engine {
    async fn execute(&self, operation: Operation, payload: Value) -> Result<Value> {
        assert_eq!(operation, Operation::Run);
        if payload["action"] == "status" {
            let started = self.runs.lock().unwrap()[payload["id"].as_str().unwrap()];
            if started.elapsed() < self.length {
                return Ok(json!({"state": "running", "results": [], "assertions": [],
                    "counts": {"results": 0, "assertions": 0, "logs": 0}}));
            }
            return Ok(json!({
                "state": "completed",
                "results": [{"name": "List orders", "status": 200}],
                "assertions": [
                    {"name": "is fast", "passed": false, "error": "took 3 s", "request": "List orders"},
                    {"name": "is 200", "passed": true, "request": "List orders"},
                ],
                "counts": {"results": 1, "assertions": 2, "logs": 0},
            }));
        }
        let mut started = self.started.lock().unwrap();
        started.push(payload);
        let id = format!("run-{}", started.len());
        self.runs.lock().unwrap().insert(id.clone(), Instant::now());
        Ok(json!({"id": id, "state": "running"}))
    }
}

pub(super) fn document(id: &str, kind: DocumentKind, value: Value) -> Document {
    Document {
        id: DocumentId::parse(id).unwrap(),
        workspace_id: WorkspaceId::parse("local").unwrap(),
        kind,
        name: format!("Doc {id}"),
        revision: 1,
        updated_at: 0,
        value,
    }
}

pub(super) fn collection() -> Document {
    document(
        "orders",
        DocumentKind::Collection,
        json!({"item": [
            {"id": "list", "name": "List orders", "request": {"url": "https://api.test/orders"}},
            {"id": "admin", "name": "Admin", "item": [
                {"id": "purge", "name": "Purge", "request": {"method": "DELETE", "url": "https://api.test/orders"}},
            ]},
        ]}),
    )
}

/// The application with the scheduler running, and what it is made of.
pub(super) async fn scheduler(
    length: Duration,
    documents: Vec<Document>,
) -> (Arc<Application>, Arc<Fake>, Arc<Engine>) {
    let fake = Arc::new(Fake::default());
    fake.workspaces.lock().unwrap().push(workspace("local"));
    fake.documents.lock().unwrap().extend(documents);
    let engine = Arc::new(Engine {
        length,
        ..Engine::default()
    });
    let application = Arc::new(Application::new(
        fake.clone(),
        engine.clone(),
        fake.clone(),
        fake.clone(),
        fake.clone(),
    ));
    let clock = Arc::new(Paused {
        base: START * 60_000 + 30_000,
        since: Instant::now(),
    });
    tokio::spawn(application.clone().run_monitors(clock));
    // The scheduler takes its clock before the test goes on.
    tokio::task::yield_now().await;
    (application, fake, engine)
}

pub(super) fn history(fake: &Fake, monitor: &str) -> Vec<Value> {
    let id = DocumentId::parse(format!("{monitor}~history")).unwrap();
    fake.documents
        .lock()
        .unwrap()
        .iter()
        .find(|d| d.id == id)
        .map(|d| d.value["runs"].as_array().cloned().unwrap_or_default())
        .unwrap_or_default()
}

pub(super) fn status(answer: &Value, monitor: &str) -> Value {
    answer["monitors"]
        .as_array()
        .unwrap()
        .iter()
        .find(|m| m["id"] == monitor)
        .cloned()
        .unwrap()
}

mod runs;
mod schedule;
