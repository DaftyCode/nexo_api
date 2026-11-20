//! The report of an import and the rows (headers, parameters, variables) every importer
//! reads, with the environments made of them.
use serde_json::{Value, json};

/// Notes a report keeps, at most.
const MAX_NOTES: usize = 500;

/// What an import brought and what it could not bring as it was. Each note has a code the
/// interface translates and the request, folder or environment it is about.
#[derive(Default)]
pub(crate) struct Report {
    pub(super) requests: usize,
    pub(super) folders: usize,
    notes: Vec<Value>,
}

impl Report {
    pub fn note(&mut self, code: &str, item: &str) {
        let note = json!({"code": code, "item": item});
        if self.notes.len() < MAX_NOTES && !self.notes.contains(&note) {
            self.notes.push(note);
        }
    }
    pub fn finish(self, source: &str, environments: usize) -> Value {
        json!({
            "source": source,
            "requests": self.requests,
            "folders": self.folders,
            "environments": environments,
            "notes": self.notes,
        })
    }
}

/// A key and a value that can be turned off: a header, a parameter or a variable.
#[derive(Clone, Default)]
pub(crate) struct Row {
    pub key: String,
    pub value: String,
    pub enabled: bool,
    pub secret: bool,
}

impl Row {
    pub fn new(key: impl Into<String>, value: impl Into<String>, enabled: bool) -> Self {
        Self {
            key: key.into(),
            value: value.into(),
            enabled,
            secret: false,
        }
    }
}

/// Headers of the folders above a request go into it, unless it sets them itself: Postman's
/// format has no headers on folders.
pub(crate) fn inherit_headers(own: &mut Vec<Row>, inherited: &[Row]) {
    let mut headers: Vec<Row> = inherited
        .iter()
        .filter(|row| {
            !own.iter()
                .any(|mine| mine.key.eq_ignore_ascii_case(&row.key))
        })
        .cloned()
        .collect();
    headers.append(own);
    *own = headers;
}

/// An environment with these variables.
pub(crate) fn environment(name: &str, rows: &[Row]) -> Value {
    let values: Vec<Value> = rows
        .iter()
        .filter(|row| !row.key.is_empty())
        .map(|row| {
            let mut value = json!({"key": row.key, "value": row.value, "enabled": row.enabled});
            if row.secret {
                value["type"] = json!("secret");
            }
            value
        })
        .collect();
    json!({"name": name, "values": values})
}

/// An authorization as imported; a type Nexo does not sign is kept as it was, with a note.
pub(crate) fn checked(auth: Option<Value>, item: &str, report: &mut Report) -> Option<Value> {
    if let Some(kind) = auth.as_ref().and_then(|auth| auth["type"].as_str())
        && !crate::auth::KNOWN.contains(&kind)
    {
        report.note("auth", item);
    }
    auth
}
