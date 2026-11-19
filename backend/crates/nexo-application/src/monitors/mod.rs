//! Monitors: a collection, or one of its folders, run on a schedule while Nexo is open.
//! There is no background service: the composition root starts `run_monitors` with the
//! application and it stops with it. Every minute it runs the monitors due then, never two
//! runs of one monitor at a time (the one that would overlap is skipped and noted), and
//! keeps the last runs of each one in its `monitor-history` document. What finished is also
//! kept in memory for a while, so the interface can notify the failures.
mod history;
mod run;
mod scheduler;
#[cfg(test)]
mod tests;

use crate::{Application, operations::Operation, ports::Clock};
use nexo_domain::{DocumentId, DocumentKind, Error, Result, WorkspaceId, monitor::Schedule};
use serde_json::{Map, Value, json};
use std::{
    collections::{HashMap, VecDeque},
    sync::{Arc, Mutex, OnceLock, Weak},
};

/// Runs kept in the history of a monitor; older ones are dropped.
pub const MONITOR_HISTORY_LIMIT: usize = 100;
/// Finished runs remembered, in memory only, for the interface to notify.
const EVENTS: usize = 50;

/// What the monitors are doing now. Nothing of it is stored.
#[derive(Default)]
pub(crate) struct Board {
    /// The application and its clock, once the scheduler runs: `monitor.run` starts runs
    /// with them.
    scheduler: OnceLock<(Weak<Application>, Arc<dyn Clock>)>,
    /// The monitors running now, with when each one started.
    running: Mutex<HashMap<String, i64>>,
    events: Mutex<Events>,
    /// One history written at a time, so two runs never save over each other.
    writing: tokio::sync::Mutex<()>,
}

#[derive(Default)]
struct Events {
    sequence: u64,
    finished: VecDeque<Value>,
}

impl Board {
    fn scheduler(&self) -> Result<(Arc<Application>, Arc<dyn Clock>)> {
        self.scheduler
            .get()
            .and_then(|(application, clock)| Some((application.upgrade()?, clock.clone())))
            .ok_or_else(|| Error::Unavailable("Monitors run only while Nexo is open".into()))
    }
    /// Marks a monitor as running; `false` when it already was.
    fn begin(&self, id: &str, now: i64) -> bool {
        let mut running = self.running.lock().unwrap_or_else(|e| e.into_inner());
        if running.contains_key(id) {
            return false;
        }
        running.insert(id.to_string(), now);
        true
    }
    fn end(&self, id: &str) {
        self.running
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(id);
    }
    fn started(&self, id: &str) -> Option<i64> {
        self.running
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(id)
            .copied()
    }
    /// Remembers a finished run with the next sequence number.
    fn finished(&self, mut event: Value) {
        let mut events = self.events.lock().unwrap_or_else(|e| e.into_inner());
        events.sequence += 1;
        event["sequence"] = json!(events.sequence);
        events.finished.push_back(event);
        while events.finished.len() > EVENTS {
            events.finished.pop_front();
        }
    }
    /// The runs that finished after `after`, and the last sequence number.
    fn since(&self, after: u64) -> (Vec<Value>, u64) {
        let events = self.events.lock().unwrap_or_else(|e| e.into_inner());
        let finished = events
            .finished
            .iter()
            .filter(|event| event["sequence"].as_u64().unwrap_or(0) > after)
            .cloned()
            .collect();
        (finished, events.sequence)
    }
}

impl Application {
    /// `monitor.status` and `monitor.run`.
    pub(crate) async fn monitor(
        &self,
        operation: Operation,
        payload: &Map<String, Value>,
    ) -> Result<Value> {
        let field = |name: &str| payload.get(name).and_then(Value::as_str).unwrap_or("");
        let workspace = WorkspaceId::parse(field("workspace"))?;
        match operation {
            Operation::MonitorStatus => {
                let after = payload.get("after").and_then(Value::as_u64).unwrap_or(0);
                self.monitor_status(&workspace, after).await
            }
            Operation::MonitorRun => {
                let document = self
                    .workspaces
                    .document(&DocumentId::parse(field("id"))?)
                    .await?;
                if document.kind != DocumentKind::Monitor || document.workspace_id != workspace {
                    return Err(Error::NotFound);
                }
                if !self.start_monitor(document, "manual").await? {
                    return Err(Error::Validation(
                        "This monitor is still running; it can run again when it finishes".into(),
                    ));
                }
                Ok(json!({"state": "running"}))
            }
            _ => Err(Error::Validation(format!(
                "{operation} is not an operation of the monitors"
            ))),
        }
    }

    /// The monitors of `workspace`: running or not and when they run next; and what finished
    /// after `after` in any workspace.
    async fn monitor_status(&self, workspace: &WorkspaceId, after: u64) -> Result<Value> {
        let scheduler = self.monitors.scheduler().ok();
        let mut monitors = Vec::new();
        for document in self
            .workspaces
            .documents(workspace, Some(DocumentKind::Monitor))
            .await?
        {
            let id = document.id.as_str();
            let mut state = json!({"id": id, "running": false, "next": null});
            if let Some(started) = self.monitors.started(id) {
                state["running"] = json!(true);
                state["startedAt"] = json!(started);
            }
            let schedule = Schedule::read(&document.value["schedule"]);
            if let (Some((_, clock)), Ok(schedule), false) =
                (&scheduler, schedule, document.value["paused"] == true)
            {
                let minute = clock.now().div_euclid(60_000);
                let next = schedule.next(minute, |minute| clock.local(minute * 60_000));
                state["next"] = json!(next.map(|minute| minute * 60_000));
            }
            monitors.push(state);
        }
        let (finished, sequence) = self.monitors.since(after);
        Ok(json!({
            "monitors": monitors,
            "finished": finished,
            "sequence": sequence,
            "scheduler": scheduler.is_some(),
        }))
    }
}
