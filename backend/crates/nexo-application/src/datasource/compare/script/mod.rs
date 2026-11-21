//! The DDL that makes the target like the source (`db.compare.script`), written by the
//! target's driver (`ddl.plan` of DB-19): tables only the source has are created (those
//! another one refers to first), those that differ are changed and, only when asked, those
//! only the target has are dropped (last). Nothing runs: the person reads the script and
//! runs it in a SQL tab, under the rules of every statement. Between two engines the source's
//! types become the target's, as a copy of DB-17 makes them; defaults and checks, written
//! for the other engine, are left out and said.
use super::{Application, Comparison, Entry, Side, refused};
use crate::{datasource::redacted, payloads::DbCompareSchemaPayload, ports::DataSources};
use nexo_domain::{
    Result,
    sql::{Dialect, compare::Status},
};
use serde_json::{Value, json};

mod adapt;
use adapt::{adapted, ordered, warning};

impl Application {
    pub(in crate::datasource) async fn compare_script(
        &self,
        sources: &dyn DataSources,
        payload: DbCompareSchemaPayload,
    ) -> Result<Value> {
        let target = self.compared_side(&payload.target.session)?;
        if target.session.read_only {
            return Err(refused(format!(
                "The connection {} is read-only: its structure cannot change",
                target.session.name
            )));
        }
        if payload.source.session == payload.target.session
            && payload.source.path == payload.target.path
        {
            return Err(refused("The source and the target are the same"));
        }
        let comparison: Comparison = self.compared(sources, &payload).await?;
        let wanted = |entry: &&Entry| {
            entry.kind == "table"
                && payload.tables.as_ref().is_none_or(|tables| {
                    let name = entry
                        .source
                        .as_ref()
                        .or(entry.target.as_ref())
                        .map(|o| o.name.clone())
                        .unwrap_or_default();
                    tables.contains(&name)
                })
        };
        let tables: Vec<&Entry> = comparison.entries.iter().filter(wanted).collect();
        let schema = tables
            .iter()
            .find_map(|entry| entry.models.1["schema"].as_str().map(String::from))
            .or_else(|| {
                (target.dialect != Dialect::MySql)
                    .then(|| payload.target.path.last().cloned())
                    .flatten()
            });
        let (from, to) = (comparison.options.source, comparison.options.target);
        let mut warnings = Vec::new();
        let mut statements = Vec::new();
        let creates = ordered(
            tables
                .iter()
                .copied()
                .filter(|e| e.status == Status::OnlySource)
                .collect(),
        );
        for entry in creates {
            let name = entry
                .source
                .as_ref()
                .map(|o| o.name.clone())
                .unwrap_or_default();
            let model = adapted(
                &entry.models.0,
                schema.as_deref(),
                &name,
                from,
                to,
                &mut warnings,
            );
            self.planned_change(
                sources,
                &target,
                Value::Null,
                model,
                &mut statements,
                &mut warnings,
            )
            .await?;
        }
        for entry in tables.iter().filter(|e| e.status == Status::Different) {
            let current = &entry.models.1;
            let name = current["name"].as_str().unwrap_or_default().to_string();
            let mut model = adapted(
                &entry.models.0,
                current["schema"].as_str(),
                &name,
                from,
                to,
                &mut warnings,
            );
            model["original"] = json!(name);
            let existing: Vec<String> = current["columns"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|c| c["name"].as_str().map(String::from))
                .collect();
            for column in model["columns"].as_array_mut().into_iter().flatten() {
                let wanted = column["name"].as_str().unwrap_or_default().to_lowercase();
                let original = existing
                    .iter()
                    .find(|name| name.to_lowercase() == wanted)
                    .cloned()
                    .unwrap_or_default();
                column["original"] = json!(original);
                column["name"] = json!(if original.is_empty() {
                    column["name"].as_str().unwrap_or_default().to_string()
                } else {
                    original
                });
            }
            self.planned_change(
                sources,
                &target,
                current.clone(),
                model,
                &mut statements,
                &mut warnings,
            )
            .await?;
        }
        if payload.drop == Some(true) {
            let drops: Vec<&Entry> = ordered(
                tables
                    .iter()
                    .copied()
                    .filter(|e| e.status == Status::OnlyTarget)
                    .collect(),
            );
            for entry in drops.into_iter().rev() {
                self.planned_change(
                    sources,
                    &target,
                    entry.models.1.clone(),
                    Value::Null,
                    &mut statements,
                    &mut warnings,
                )
                .await?;
            }
        }
        let others = comparison
            .entries
            .iter()
            .filter(|e| {
                e.kind != "table" && matches!(e.status, Status::Different | Status::OnlySource)
            })
            .count();
        if others > 0 {
            warnings.push(warning("db.compare.warn.others", &others.to_string()));
        }
        Ok(json!({"statements": statements, "warnings": warnings}))
    }

    /// The statements of one change of a table, added to the script.
    async fn planned_change(
        &self,
        sources: &dyn DataSources,
        target: &Side,
        original: Value,
        model: Value,
        statements: &mut Vec<String>,
        warnings: &mut Vec<Value>,
    ) -> Result<()> {
        let request = json!({"connection": target.name, "original": original, "target": model, "cascade": false});
        let plan = redacted(
            sources.ddl_plan(&target.name, request).await,
            &target.session,
        )?;
        statements.extend(
            plan["statements"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|s| s.as_str().map(String::from)),
        );
        // The driver's warnings are texts of the catalogs, as the structure editor shows them.
        warnings.extend(
            plan["warnings"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|s| s.as_str().map(|text| json!({"text": text}))),
        );
        Ok(())
    }
}
