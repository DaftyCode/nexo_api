//! One run of a monitor: the collection run it starts, followed until it ends, and the
//! summary its history keeps (counts and failures, never responses).
use super::*;
use crate::environments::Sender;
use nexo_domain::Document;
use std::time::Duration;

/// How often a run in progress is asked how it goes.
const POLL: Duration = Duration::from_secs(1);
/// Failures kept in the summary of a run.
const FAILURES: usize = 20;
/// Characters kept of each text of a failure.
const TEXT: usize = 500;

fn cut(value: &Value) -> Value {
    match value.as_str() {
        Some(text) if text.chars().count() > TEXT => {
            json!(format!("{}…", text.chars().take(TEXT).collect::<String>()))
        }
        _ => value.clone(),
    }
}

/// What a run delivered so far.
#[derive(Default)]
struct Summary {
    requests: u64,
    failed_requests: u64,
    passed: u64,
    failed: u64,
    failures: Vec<Value>,
}
impl Summary {
    fn failure(&mut self, failure: Value) {
        if self.failures.len() < FAILURES {
            self.failures.push(failure);
        }
    }
    /// Adds the results and assertions of a status of the run.
    fn add(&mut self, view: &Value) {
        for result in view["results"].as_array().into_iter().flatten() {
            self.requests += 1;
            if result["error"].is_string() || result["status"] == 0 {
                self.failed_requests += 1;
                self.failure(
                    json!({"request": cut(&result["name"]), "error": cut(&result["error"])}),
                );
            }
        }
        for assertion in view["assertions"].as_array().into_iter().flatten() {
            if assertion["passed"] == true {
                self.passed += 1;
            } else {
                self.failed += 1;
                self.failure(json!({
                    "request": cut(&assertion["request"]),
                    "assertion": cut(&assertion["name"]),
                    "error": cut(&assertion["error"]),
                }));
            }
        }
    }
}

/// Finds the folder `id` among the items of a collection, at any depth.
fn folder(items: &Value, id: &str) -> Option<Value> {
    items.as_array()?.iter().find_map(|item| {
        let is_folder = item["item"].is_array();
        if is_folder && item["id"].as_str() == Some(id) {
            Some(item.clone())
        } else {
            folder(&item["item"], id)
        }
    })
}

/// Variables as the run takes them: rows with a name.
fn rows(values: &Value) -> Value {
    Value::Array(
        values
            .as_array()
            .into_iter()
            .flatten()
            .filter(|row| {
                row["key"]
                    .as_str()
                    .is_some_and(|key| !key.trim().is_empty())
            })
            .cloned()
            .collect(),
    )
}

impl Application {
    /// A document of the monitor's workspace, of `kind`, or why the monitor cannot run.
    async fn monitor_part(
        &self,
        monitor: &Document,
        field: &str,
        kind: DocumentKind,
    ) -> Result<Option<Document>> {
        let Some(id) = monitor.value[field].as_str().filter(|id| !id.is_empty()) else {
            return Ok(None);
        };
        let gone = || Error::Validation(format!("The {field} of this monitor no longer exists"));
        let document = self
            .workspaces
            .document(&DocumentId::parse(id).map_err(|_| gone())?)
            .await
            .map_err(|_| gone())?;
        if document.kind != kind || document.workspace_id != monitor.workspace_id {
            return Err(gone());
        }
        Ok(Some(document))
    }

    /// The collection run of a monitor, as the runner of the interface starts it.
    async fn monitor_payload(&self, monitor: &Document) -> Result<Value> {
        let value = &monitor.value;
        let collection = self
            .monitor_part(monitor, "collection", DocumentKind::Collection)
            .await?
            .ok_or_else(|| Error::Validation("Choose the collection to run".into()))?;
        let mut collection = collection.value;
        if let Some(id) = value["folder"].as_str().filter(|id| !id.is_empty()) {
            let folder = folder(&collection["item"], id).ok_or_else(|| {
                Error::Validation("The folder of this monitor no longer exists".into())
            })?;
            collection["item"] = json!([folder]);
        }
        let environment = self
            .monitor_part(monitor, "environment", DocumentKind::Environment)
            .await?;
        let globals = self
            .workspaces
            .documents(&monitor.workspace_id, Some(DocumentKind::Globals))
            .await?;
        let mut payload = json!({
            "workspace": monitor.workspace_id.as_str(),
            "collection": collection,
            "variables": rows(&environment.as_ref().map_or(Value::Null, |e| e.value["values"].clone())),
            "globals": rows(&globals.first().map_or(Value::Null, |g| g.value["values"].clone())),
            "iterations": value["iterations"].as_u64().unwrap_or(1),
        });
        if let Some(environment) = environment {
            payload["environment"] = json!(environment.id.as_str());
        }
        if let Some(delay) = value["delay"].as_u64().filter(|delay| *delay > 0) {
            payload["delay"] = json!(delay);
        }
        if let Some(data) = value["data"].as_array().filter(|data| !data.is_empty()) {
            payload["data"] = json!(data);
        }
        Ok(payload)
    }

    /// Runs a monitor to its end and returns the entry of its history.
    pub(super) async fn monitor_run(
        &self,
        monitor: &Document,
        trigger: &str,
        started: i64,
    ) -> Value {
        let mut summary = Summary::default();
        let ended = self.follow_run(monitor, &mut summary).await;
        let duration = self
            .monitors
            .scheduler()
            .map(|(_, clock)| clock.now() - started)
            .unwrap_or(0)
            .max(0);
        let mut entry = json!({
            "startedAt": started,
            "duration": duration,
            "trigger": trigger,
            "requests": summary.requests,
            "failedRequests": summary.failed_requests,
            "passedAssertions": summary.passed,
            "failedAssertions": summary.failed,
            "failures": summary.failures,
        });
        let (state, error) = match ended {
            Ok((engine, error)) => match (engine.as_str(), error) {
                ("completed", None) if summary.failed + summary.failed_requests == 0 => {
                    ("passed", None)
                }
                ("completed", None) => ("failed", None),
                (_, error) => (
                    "error",
                    Some(error.unwrap_or_else(|| "The run did not finish".into())),
                ),
            },
            Err(error) => ("error", Some(error.to_string())),
        };
        entry["state"] = json!(state);
        if let Some(error) = error {
            entry["error"] = cut(&json!(error));
        }
        entry
    }

    /// Starts the run and follows it; returns how the engine says it ended and its error.
    async fn follow_run(
        &self,
        monitor: &Document,
        summary: &mut Summary,
    ) -> Result<(String, Option<String>)> {
        let payload = self.monitor_payload(monitor).await?;
        let allow_changes = monitor.value["allowChanges"] == true;
        let payload = self.checked(Operation::Run, payload).await?;
        let started = self
            .engine(Operation::Run, payload, Sender::Monitor { allow_changes })
            .await?;
        let id = started["id"]
            .as_str()
            .ok_or_else(|| Error::Infrastructure("The run did not start".into()))?
            .to_string();
        let mut after = json!({});
        loop {
            tokio::time::sleep(POLL).await;
            let status = json!({"action": "status", "id": id, "after": after});
            let view = self.executor.execute(Operation::Run, status).await?;
            summary.add(&view);
            after = view["counts"].clone();
            let state = view["state"].as_str().unwrap_or("failed");
            if !matches!(state, "running" | "paused") {
                let error = view["error"].as_str().map(String::from);
                return Ok((state.to_string(), error));
            }
        }
    }
}
