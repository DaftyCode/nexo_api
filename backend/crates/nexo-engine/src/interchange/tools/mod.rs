//! Imports from other API clients (B-07): Insomnia, Bruno, Hoppscotch and Thunder Client.
//!
//! Each importer reads its tool's export and builds Nexo documents: a collection in
//! Postman's format, with its folders, authorization and variables, and the environments
//! that came with it. Scripts use each tool's own API, so they arrive commented out with a
//! note; the report says what was imported and what could not be brought as it was.

mod body;
mod bruno;
mod build;
mod hoppscotch;
mod insomnia;
mod report;
mod thunder;
mod vars;

use nexo_domain::{Error, Result};
use report::{Report, Row};
use serde_json::{Value, json};

/// A document an import creates: its kind (`collection` or `environment`), name and value.
pub(crate) struct Document {
    kind: &'static str,
    name: String,
    value: Value,
}

impl Document {
    fn collection(value: Value) -> Self {
        let name = value["info"]["name"]
            .as_str()
            .unwrap_or("Imported")
            .to_string();
        Self {
            kind: "collection",
            name,
            value,
        }
    }
    fn environment(value: Value) -> Self {
        let name = value["name"].as_str().unwrap_or("Imported").to_string();
        Self {
            kind: "environment",
            name,
            value,
        }
    }
}

/// The import of another tool's export, when the content is one; `files` are the files of
/// a Bruno collection folder.
pub fn import(document: Option<&Value>, files: &[Value]) -> Option<Result<Value>> {
    let mut report = Report::default();
    let (source, documents) = if !files.is_empty() {
        ("bruno", bruno::folder(files, &mut report))
    } else {
        let document = document?;
        if insomnia::is_export(document) {
            ("insomnia", insomnia::import(document, &mut report))
        } else if thunder::is_export(document) {
            ("thunder", thunder::import(document, &mut report))
        } else if bruno::is_export(document) {
            ("bruno", bruno::export(document, &mut report))
        } else if hoppscotch::is_export(document) {
            ("hoppscotch", hoppscotch::import(document, &mut report))
        } else {
            return None;
        }
    };
    Some(documents.and_then(|documents| finish(source, documents, report)))
}

/// The result of an import: the first document as `kind`, `name` and `value` (what single
/// imports return), the rest in `more`, and the report.
fn finish(source: &str, documents: Vec<Document>, report: Report) -> Result<Value> {
    let mut documents = documents.into_iter();
    let first = documents
        .next()
        .ok_or_else(|| Error::Validation("There is nothing to import in this file".into()))?;
    let more: Vec<Value> = documents
        .map(|document| json!({"kind": document.kind, "name": document.name, "value": document.value}))
        .collect();
    let environments = more.iter().filter(|d| d["kind"] == "environment").count()
        + usize::from(first.kind == "environment");
    Ok(json!({
        "kind": first.kind,
        "name": first.name,
        "value": first.value,
        "more": more,
        "report": report.finish(source, environments),
    }))
}

/// Text of a JSON value as each tool writes its values: strings as they are, other values
/// as JSON, nothing for null.
pub(crate) fn text(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        Value::Null => String::new(),
        other => other.to_string(),
    }
}

/// The items of an array, or none.
pub(crate) fn list(value: &Value) -> &[Value] {
    value.as_array().map(Vec::as_slice).unwrap_or_default()
}

#[cfg(test)]
mod tests;
