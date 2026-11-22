//! The scheduler: once a minute, the monitors due in that minute of this computer's clock.
use super::*;
use nexo_domain::Document;
use std::time::Duration;

const MINUTE: i64 = 60_000;

impl Application {
    /// Runs the monitors of every workspace on their schedules until the application stops.
    /// The minute it starts in is not run: it may be half gone.
    pub async fn run_monitors(self: Arc<Self>, clock: Arc<dyn Clock>) {
        let _ = self
            .monitors
            .scheduler
            .set((Arc::downgrade(&self), clock.clone()));
        let mut last = clock.now().div_euclid(MINUTE);
        loop {
            let now = clock.now();
            let wait = MINUTE - now.rem_euclid(MINUTE);
            tokio::time::sleep(Duration::from_millis(wait as u64)).await;
            let minute = clock.now().div_euclid(MINUTE);
            // A timer that wakes a little early sleeps again; a clock moved back waits for
            // the minute it had reached.
            if minute <= last {
                continue;
            }
            last = minute;
            if let Err(error) = self.run_due(clock.local(minute * MINUTE)).await {
                tracing::warn!(%error, "Monitors could not be checked");
            }
        }
    }

    /// Starts the monitors and the database tasks due at `time`, in every workspace.
    async fn run_due(&self, time: nexo_domain::monitor::LocalTime) -> Result<()> {
        for workspace in self.workspaces.workspaces().await? {
            for document in self
                .workspaces
                .documents(&workspace.id, Some(DocumentKind::DbTask))
                .await?
            {
                let due = document.value["paused"] != true
                    && !document.value["schedule"].is_null()
                    && Schedule::read(&document.value["schedule"])
                        .is_ok_and(|schedule| schedule.due(&time));
                let id = document.id.clone();
                if due && let Err(error) = self.start_task(document).await {
                    tracing::warn!(%error, task = %id, "A database task could not start");
                }
            }
            for document in self
                .workspaces
                .documents(&workspace.id, Some(DocumentKind::Monitor))
                .await?
            {
                let due = document.value["paused"] != true
                    && Schedule::read(&document.value["schedule"])
                        .is_ok_and(|schedule| schedule.due(&time));
                let id = document.id.clone();
                if due && let Err(error) = self.start_monitor(document, "schedule").await {
                    tracing::warn!(%error, monitor = %id, "A monitor could not start");
                }
            }
        }
        Ok(())
    }

    /// Starts a scheduled run of a database task, unless the last one has not finished: that
    /// one is noted as skipped.
    async fn start_task(&self, document: Document) -> Result<()> {
        let (application, clock) = self.monitors.scheduler()?;
        let now = clock.now();
        let id = document.id.to_string();
        if !self.monitors.begin(&id, now) {
            let entry = json!({"startedAt": now, "duration": 0, "trigger": "schedule",
                "state": "skipped", "error": "The previous run had not finished"});
            return self.record_run(&document, entry).await;
        }
        tokio::spawn(async move {
            let entry = application.task_run(&document, "schedule", now).await;
            if let Err(error) = application.record_run(&document, entry).await {
                tracing::warn!(%error, task = %document.id, "The run of a task was not kept");
            }
            application.monitors.end(document.id.as_str());
        });
        Ok(())
    }

    /// Starts a run of a monitor; `false` when the last one has not finished. A scheduled
    /// run that would overlap it is skipped and noted in the history.
    pub(super) async fn start_monitor(&self, document: Document, trigger: &str) -> Result<bool> {
        let (application, clock) = self.monitors.scheduler()?;
        let now = clock.now();
        let id = document.id.to_string();
        if !self.monitors.begin(&id, now) {
            if trigger == "schedule" {
                let entry = json!({
                    "startedAt": now,
                    "duration": 0,
                    "trigger": trigger,
                    "state": "skipped",
                    "error": "The previous run had not finished",
                });
                self.record_run(&document, entry).await?;
            }
            return Ok(false);
        }
        let trigger = trigger.to_string();
        tokio::spawn(async move {
            let entry = application.monitor_run(&document, &trigger, now).await;
            if let Err(error) = application.record_run(&document, entry).await {
                tracing::warn!(%error, monitor = %document.id, "The run of a monitor was not kept");
            }
            application.monitors.end(document.id.as_str());
        });
        Ok(true)
    }
}
