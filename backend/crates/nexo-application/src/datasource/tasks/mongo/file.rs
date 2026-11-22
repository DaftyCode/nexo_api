//! The files of MongoDB transfers in tasks: documents written as JSON, JSON Lines or CSV, and
//! JSON read back to import it.
use super::{BATCH, invalid};
use crate::{
    Application,
    datasource::tasks::{Report, files::READ_LIMIT},
};
use nexo_domain::{
    DocumentKind, Result, WorkspaceId,
    transfer_file::{FileFormat, csv_line, document_lines, read_objects},
};
use serde_json::{Map, Value, json};

/// A value of Extended JSON as the text of a CSV cell.
fn ejson_text(value: &Value) -> Option<String> {
    match value {
        Value::Null => None,
        Value::String(text) => Some(text.clone()),
        Value::Object(fields) if fields.len() == 1 => {
            let (key, inner) = fields.iter().next()?;
            match (key.as_str(), inner) {
                ("$date", Value::Object(date)) => ejson_text(date.get("$numberLong")?),
                (key, Value::String(text)) if key.starts_with('$') => Some(text.clone()),
                _ => Some(value.to_string()),
            }
        }
        other => Some(other.to_string()),
    }
}

/// Canonical Extended JSON with its numbers written plainly (the relaxed flavour).
fn relaxed(value: Value) -> Value {
    match value {
        Value::Object(fields) if fields.len() == 1 => {
            let (key, inner) = fields
                .iter()
                .next()
                .map(|(k, v)| (k.clone(), v.clone()))
                .unwrap();
            let number = inner.as_str().and_then(|text| text.parse::<f64>().ok());
            match (key.as_str(), number) {
                ("$numberInt" | "$numberLong", Some(n)) if n.abs() < 9_007_199_254_740_992.0 => {
                    json!(n as i64)
                }
                ("$numberDouble", Some(n)) if n.is_finite() => json!(n),
                _ => Value::Object(
                    [(key, relaxed(inner))]
                        .into_iter()
                        .collect::<Map<String, Value>>(),
                ),
            }
        }
        Value::Object(fields) => {
            Value::Object(fields.into_iter().map(|(k, v)| (k, relaxed(v))).collect())
        }
        Value::Array(items) => Value::Array(items.into_iter().map(relaxed).collect()),
        other => other,
    }
}

/// A field of a document by its dotted path.
fn field<'a>(document: &'a Value, path: &str) -> &'a Value {
    path.split('.').fold(document, |value, part| &value[part])
}

impl Application {
    pub(super) fn file_opening(&self, format: FileFormat, value: &Value) -> String {
        match format {
            FileFormat::Json => "[".into(),
            FileFormat::Csv => {
                let fields: Vec<Option<String>> = value["fields"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .map(|field| field.as_str().map(str::to_owned))
                    .collect();
                csv_line(&fields, ',')
            }
            FileFormat::JsonLines => String::new(),
        }
    }

    pub(super) fn file_part(
        &self,
        format: FileFormat,
        value: &Value,
        documents: &[Value],
        first: bool,
    ) -> String {
        if format == FileFormat::Csv {
            let fields: Vec<&str> = value["fields"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
                .collect();
            return documents
                .iter()
                .map(|document| {
                    let cells: Vec<Option<String>> = fields
                        .iter()
                        .map(|path| ejson_text(field(document, path)))
                        .collect();
                    csv_line(&cells, ',')
                })
                .collect();
        }
        let documents: Vec<Value> = if value["flavour"] == "relaxed" {
            documents.iter().cloned().map(relaxed).collect()
        } else {
            documents.to_vec()
        };
        document_lines(&documents, format, first)
    }

    pub(super) async fn mongo_import_file(
        &self,
        workspace: &WorkspaceId,
        task: &Value,
        value: &Value,
        place: Value,
        report: &mut Report,
    ) -> Result<()> {
        let format = FileFormat::parse(value["format"].as_str().unwrap_or_default())
            .ok()
            .filter(|format| *format != FileFormat::Csv)
            .ok_or_else(|| invalid("A task imports MongoDB documents from JSON or JSON Lines"))?;
        let path = task["file"].as_str().unwrap_or_default();
        let bytes = self.task_files()?.read(path, READ_LIMIT).await?;
        let text =
            String::from_utf8(bytes).map_err(|_| invalid(format!("{path} is not UTF-8 text")))?;
        let documents: Vec<Value> = read_objects(&text, format)?
            .into_iter()
            .map(Value::Object)
            .collect();
        let connection = self
            .saved(workspace, &value["connection"], DocumentKind::Connection)
            .await?;
        for (at, batch) in documents.chunks(BATCH as usize).enumerate() {
            self.mongo_write(task, value, &connection, &place, batch, at == 0, report)
                .await?;
        }
        report.statements += 1;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extended_json_is_written_plainly_where_nothing_is_lost() {
        assert_eq!(
            relaxed(
                json!({"a": {"$numberInt": "3"}, "b": [{"$numberDouble": "1.5"}],
                          "c": {"$numberLong": "9007199254740993"}, "d": {"$numberDouble": "NaN"}})
            ),
            json!({"a": 3, "b": [1.5], "c": {"$numberLong": "9007199254740993"},
                   "d": {"$numberDouble": "NaN"}})
        );
        assert_eq!(ejson_text(&json!({"$oid": "65a1"})), Some("65a1".into()));
        assert_eq!(
            ejson_text(&json!({"$date": {"$numberLong": "17"}})),
            Some("17".into())
        );
        assert_eq!(
            ejson_text(&json!({"a": 1, "b": 2})),
            Some("{\"a\":1,\"b\":2}".into())
        );
        assert_eq!(ejson_text(&json!({"a": 1})), Some("{\"a\":1}".into()));
        assert_eq!(ejson_text(&Value::Null), None);
        assert_eq!(field(&json!({"a": {"b": 2}}), "a.b"), &json!(2));
    }
}
