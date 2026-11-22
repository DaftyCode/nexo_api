//! The history of a monitor: one `monitor-history` document per monitor with its last runs,
//! newest first, deleted with the monitor.
use super::*;
use nexo_domain::Document;

/// The id of the history of monitor `id`.
fn history_id(monitor: &DocumentId) -> Result<DocumentId> {
    DocumentId::parse(format!("{monitor}~history"))
}

impl Application {
    /// Adds a run to the history of a monitor, keeps the last ones and remembers it for the
    /// interface to notify. A monitor deleted while it ran keeps nothing.
    pub(crate) async fn record_run(&self, monitor: &Document, entry: Value) -> Result<()> {
        let _writing = self.monitors.writing.lock().await;
        if self.workspaces.document(&monitor.id).await.is_err() {
            return Ok(());
        }
        let id = history_id(&monitor.id)?;
        let (revision, mut runs) = match self.workspaces.document(&id).await {
            Ok(history) => (
                history.revision,
                history.value["runs"]
                    .as_array()
                    .cloned()
                    .unwrap_or_default(),
            ),
            Err(_) => (0, Vec::new()),
        };
        runs.insert(0, entry.clone());
        runs.truncate(MONITOR_HISTORY_LIMIT);
        self.workspaces
            .save(Document {
                id,
                workspace_id: monitor.workspace_id.clone(),
                kind: DocumentKind::MonitorHistory,
                name: monitor.name.clone(),
                revision,
                updated_at: 0,
                value: json!({"monitor": monitor.id.as_str(), "runs": runs}),
            })
            .await?;
        let mut event = json!({
            "workspace": monitor.workspace_id.as_str(),
            "monitor": monitor.id.as_str(),
            "name": monitor.name,
            "kind": monitor.kind.as_str(),
            // A database task (DB-31) always tells its failures and its differences.
            "notify": monitor.value["notify"] == true || monitor.kind == DocumentKind::DbTask,
        });
        for field in [
            "state",
            "startedAt",
            "failedAssertions",
            "failedRequests",
            "differences",
            "error",
        ] {
            if let Some(value) = entry.get(field) {
                event[field] = value.clone();
            }
        }
        self.monitors.finished(event);
        Ok(())
    }

    /// Deletes the history of a monitor that was deleted.
    pub(crate) async fn forget_monitor(&self, monitor: &DocumentId) -> Result<()> {
        let _writing = self.monitors.writing.lock().await;
        let id = history_id(monitor)?;
        match self.workspaces.document(&id).await {
            Ok(history) => self.workspaces.delete(&id, history.revision).await,
            Err(_) => Ok(()),
        }
    }
}
