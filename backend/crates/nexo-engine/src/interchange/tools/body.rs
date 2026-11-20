//! Request bodies in Nexo's (Postman's) format.
use super::{Report, Row};
use serde_json::{Value, json};

/// The language of a raw body of this media type, as the editor names it.
pub(crate) fn language(media: &str) -> &'static str {
    let media = media.to_ascii_lowercase();
    if media.contains("json") {
        "json"
    } else if media.contains("xml") {
        "xml"
    } else if media.contains("html") {
        "html"
    } else if media.contains("javascript") {
        "javascript"
    } else {
        "text"
    }
}

pub(crate) fn raw(text: &str, language: &str) -> Value {
    json!({"mode": "raw", "raw": text, "options": {"raw": {"language": language}}})
}

pub(crate) fn urlencoded(rows: &[Row]) -> Value {
    let rows: Vec<Value> = rows
        .iter()
        .filter(|row| !row.key.is_empty())
        .map(|row| json!({"key": row.key, "value": row.value, "type": "text", "disabled": !row.enabled}))
        .collect();
    json!({"mode": "urlencoded", "urlencoded": rows})
}

/// A part of a form-data body: a text, or files to choose again (`files` names them).
pub(crate) struct Part {
    pub row: Row,
    pub files: Option<Vec<String>>,
    pub content_type: String,
}

/// A form-data body; parts with files are noted, since the files have to be chosen again.
pub(crate) fn formdata(parts: Vec<Part>, item: &str, report: &mut Report) -> Value {
    let rows: Vec<Value> = parts
        .into_iter()
        .filter(|part| !part.row.key.is_empty())
        .map(|part| {
            let mut row = match part.files {
                Some(files) => {
                    report.note("file", item);
                    let src = match files.as_slice() {
                        [one] => json!(file_name(one)),
                        many => json!(many.iter().map(|f| file_name(f)).collect::<Vec<_>>()),
                    };
                    json!({"key": part.row.key, "type": "file", "src": src})
                }
                None => json!({"key": part.row.key, "value": part.row.value, "type": "text"}),
            };
            row["disabled"] = json!(!part.row.enabled);
            if !part.content_type.is_empty() {
                row["contentType"] = json!(part.content_type);
            }
            row
        })
        .collect();
    json!({"mode": "formdata", "formdata": rows})
}

/// A binary body: the file is named and has to be chosen again.
pub(crate) fn binary(file: &str, item: &str, report: &mut Report) -> Value {
    report.note("file", item);
    json!({"mode": "file", "file": {"src": file_name(file)}})
}

pub(crate) fn graphql(query: &str, variables: &str) -> Value {
    let variables = if variables.trim().is_empty() {
        "{}"
    } else {
        variables
    };
    json!({"mode": "graphql", "graphql": {"query": query, "variables": variables}})
}

/// The name of a file without the folders of the computer it came from.
fn file_name(path: &str) -> String {
    path.rsplit(['/', '\\']).next().unwrap_or(path).to_string()
}
