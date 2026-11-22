//! A saved MongoDB comparison in a task: its differences, and the sync the task authorizes.
use super::invalid;
use crate::{
    Application,
    datasource::tasks::{Authorized, Report},
    operations::Operation,
};
use nexo_domain::{DocumentKind, Result, WorkspaceId};
use serde_json::{Value, json};

impl Application {
    /// `mongo-compare`: runs a saved comparison; with `sync`, makes the target like the source
    /// when the task authorizes it.
    pub(in crate::datasource::tasks) async fn run_mongo_compare(
        &self,
        workspace: &WorkspaceId,
        task: &Value,
        report: &mut Report,
    ) -> Result<()> {
        let saved = self
            .saved(workspace, &task["comparison"], DocumentKind::Comparison)
            .await?;
        let value = &saved.value;
        let filter_typed = value["filter"]
            .as_str()
            .is_some_and(|text| !text.trim().is_empty());
        if filter_typed && !value["builtFilter"].is_object() {
            return Err(invalid(
                "Open the saved comparison and save it again: a task runs the filter it keeps",
            ));
        }
        let (_, source) = self.mongo_side(workspace, value).await?;
        let (target_connection, target) = self.mongo_side(workspace, &value["target"]).await?;
        let side = |place: &Value| json!({"connection": place["connection"], "database": place["database"], "collection": place["collection"]});
        let mut rules = json!({"key": value["key"].as_str().filter(|k| !k.is_empty()).unwrap_or("_id"),
                               "ignore": value["ignore"].as_array().cloned().unwrap_or_default()});
        if filter_typed {
            rules["filter"] = value["builtFilter"].clone();
        }
        let mut payload = rules.clone();
        payload["workspace"] = json!(workspace.as_str());
        payload["id"] = json!(format!("task-{}", uuid::Uuid::new_v4().simple()));
        payload["source"] = side(&source);
        payload["target"] = side(&target);
        payload["kept"] = json!(1);
        let answer = self.execute(Operation::MongoCompare, payload).await?;
        report.statements += 1;
        let counts = &answer["counts"];
        report.differences = ["onlySource", "onlyTarget", "different"]
            .iter()
            .map(|key| counts[key].as_u64().unwrap_or(0))
            .sum();
        if task["sync"] != true || report.differences == 0 {
            return Ok(());
        }
        let authorized = Authorized::of(task);
        let collection = target["collection"].as_str().unwrap_or_default();
        if !authorized.allows("writes") {
            return Err(invalid(format!(
                "The task does not authorize syncing {collection}"
            )));
        }
        let remove = value["remove"] == true;
        if remove && !authorized.allows("everyRow") {
            return Err(invalid(format!(
                "The task does not authorize deleting what only {collection} has"
            )));
        }
        let mut sync = rules;
        sync["workspace"] = json!(workspace.as_str());
        sync["id"] = json!(format!("task-{}", uuid::Uuid::new_v4().simple()));
        sync["connection"] = target["connection"].clone();
        sync["connectionId"] = json!(target_connection.id.as_str());
        sync["database"] = target["database"].clone();
        sync["collection"] = json!(collection);
        sync["source"] = side(&source);
        sync["confirm"] = json!(collection);
        sync["remove"] = json!(remove);
        let synced = self.execute(Operation::MongoSync, sync).await?;
        report.statements += 1;
        report.rows += ["inserted", "replaced", "deleted"]
            .iter()
            .map(|key| synced[key].as_u64().unwrap_or(0))
            .sum::<u64>();
        Ok(())
    }
}
