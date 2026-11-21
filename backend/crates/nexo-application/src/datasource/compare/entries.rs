//! How each object of the two sides stands, and the answer of a comparison of structure.
use super::{Application, CompareSide, Object, Side};
use crate::{datasource::redacted, payloads::DbCompareSchemaPayload, ports::DataSources};
use nexo_domain::{
    Result,
    sql::compare::{Options, Status, compare_tables, definition},
};
use serde_json::{Value, json};

impl Application {
    /// How one object stands: tables part by part, other objects by their definitions (in
    /// one engine; between two they are only paired).
    #[allow(clippy::too_many_arguments)]
    pub(super) async fn compared_entry(
        &self,
        sources: &dyn DataSources,
        source: &Side,
        target: &Side,
        options: &Options,
        x: Option<Object>,
        y: Option<Object>,
        payload: &DbCompareSchemaPayload,
    ) -> Result<Entry> {
        let kind = x
            .as_ref()
            .or(y.as_ref())
            .map(|o| o.kind.clone())
            .unwrap_or_default();
        let mut entry = Entry {
            kind: kind.clone(),
            source: x.clone(),
            target: y.clone(),
            status: Status::Equal,
            differences: Vec::new(),
            models: (Value::Null, Value::Null),
        };
        let (Some(x), Some(y)) = (&x, &y) else {
            entry.status = if x.is_some() {
                Status::OnlySource
            } else {
                Status::OnlyTarget
            };
            match (kind.as_str(), &x, &y) {
                ("table", Some(x), _) => {
                    entry.models.0 = self.compared_model(sources, source, &x.path).await?
                }
                ("table", None, Some(y)) => {
                    entry.models.1 = self.compared_model(sources, target, &y.path).await?
                }
                _ => {}
            }
            return Ok(entry);
        };
        if kind == "table" {
            let (a, b) = (
                self.compared_model(sources, source, &x.path).await?,
                self.compared_model(sources, target, &y.path).await?,
            );
            entry.differences = serde_json::to_value(compare_tables(&a, &b, options))
                .unwrap_or_default()
                .as_array()
                .cloned()
                .unwrap_or_default();
            entry.status = if entry
                .differences
                .iter()
                .any(|d| d["status"] != "equivalent")
            {
                Status::Different
            } else if entry.differences.is_empty() {
                Status::Equal
            } else {
                Status::Equivalent
            };
            entry.models = (a, b);
        } else if options.between() {
            entry.status = Status::Equivalent;
        } else {
            let text = |answer: Value| answer["sql"].as_str().unwrap_or_default().to_string();
            let a = text(redacted(
                sources.ddl(&source.name, x.path.clone()).await,
                &source.session,
            )?);
            let b = text(redacted(
                sources.ddl(&target.name, y.path.clone()).await,
                &target.session,
            )?);
            let schema = |side: &CompareSide| side.path.last().cloned();
            if definition(&a, schema(&payload.source).as_deref())
                != definition(&b, schema(&payload.target).as_deref())
            {
                entry.status = Status::Different;
            }
            entry.models = (json!(a), json!(b));
        }
        Ok(entry)
    }
}

/// An object of either side and how it stands.
pub(super) struct Entry {
    pub kind: String,
    pub source: Option<Object>,
    pub target: Option<Object>,
    pub status: Status,
    pub differences: Vec<Value>,
    /// Tables: their models; other objects: their definitions.
    pub models: (Value, Value),
}

pub(super) struct Comparison {
    pub options: Options,
    pub entries: Vec<Entry>,
}

impl Comparison {
    pub(super) fn answer(&self) -> Value {
        let mut counts =
            json!({"equal": 0, "equivalent": 0, "different": 0, "onlySource": 0, "onlyTarget": 0});
        let objects: Vec<Value> = self
            .entries
            .iter()
            .map(|entry| {
                let status = serde_json::to_value(entry.status).unwrap_or_default();
                if let Some(count) = counts.get_mut(status.as_str().unwrap_or_default()) {
                    *count = json!(count.as_u64().unwrap_or(0) + 1);
                }
                let name = entry
                    .source
                    .as_ref()
                    .or(entry.target.as_ref())
                    .map(|o| o.name.clone());
                let mut object = json!({
                    "kind": entry.kind,
                    "name": name,
                    "status": status,
                    "sourcePath": entry.source.as_ref().map(|o| &o.path),
                    "targetPath": entry.target.as_ref().map(|o| &o.path),
                    "differences": entry.differences,
                });
                if entry.kind != "table" && entry.status == Status::Different {
                    object["sourceDefinition"] = entry.models.0.clone();
                    object["targetDefinition"] = entry.models.1.clone();
                }
                object
            })
            .collect();
        json!({"between": self.options.between(), "objects": objects, "counts": counts})
    }
}
