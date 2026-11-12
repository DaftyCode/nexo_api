//! Files sent with a request: form-data fields of type `file` and binary bodies
//! (`body.mode = "file"`), as Postman stores them, with only the file name (`src`).
//!
//! The engine never reads paths: the person chooses each file in the interface (or the CLI
//! reads it next to the collection), and the payload brings its contents in `files`, apart
//! from the request. Scripts and saved documents only see `src`. Right before sending, each
//! reference gets the content chosen for its name, in order, and nothing of it is returned.
use base64::{Engine as _, engine::general_purpose::STANDARD};
use nexo_domain::{Error, Result};
use serde_json::{Value, json};

/// The most a request may carry in files, decoded.
pub const MAX_TOTAL: usize = 32 * 1024 * 1024;
/// Where the content of a reference is put for the transport, and removed from afterwards.
const ATTACHED: &str = "nexoFiles";

/// A file chosen for a request.
#[derive(Clone, Debug)]
struct File {
    src: String,
    /// Base64, decoded when the body is built.
    content: String,
    content_type: Option<String>,
}

/// The files a payload brings, in the order they were chosen.
#[derive(Clone, Debug, Default)]
pub struct Files(Vec<File>);

impl Files {
    /// Reads `files` (`[{src, content, contentType}]`), checking the base64 and the total size.
    pub fn from_payload(payload: &Value) -> Result<Self> {
        let mut files = Vec::new();
        let mut total = 0usize;
        for entry in payload["files"].as_array().into_iter().flatten() {
            let src = entry["src"].as_str().unwrap_or_default().to_string();
            let content = entry["content"].as_str().unwrap_or_default().to_string();
            let decoded = STANDARD
                .decode(&content)
                .map_err(|_| Error::Validation(format!("File {src} is not valid base64")))?;
            total += decoded.len();
            if total > MAX_TOTAL {
                return Err(Error::Validation(
                    "Files sent with a request can add up to 32 MB".into(),
                ));
            }
            files.push(File {
                src,
                content,
                content_type: entry["contentType"]
                    .as_str()
                    .filter(|value| !value.trim().is_empty())
                    .map(String::from),
            });
        }
        Ok(Self(files))
    }

    /// Gives every file reference of a collection-format request the content chosen for its
    /// name. Each file is used once, so two fields with the same name get their own files.
    /// References without a chosen file are left for the transport to report.
    pub fn attach(&self, request: &mut Value) {
        if self.0.is_empty() {
            return;
        }
        let mut used = vec![false; self.0.len()];
        let mut take = |src: &str, content_type: Option<&str>| {
            let index = self
                .0
                .iter()
                .enumerate()
                .position(|(index, file)| !used[index] && file.src == src)?;
            used[index] = true;
            let file = &self.0[index];
            Some(json!({
                "name": file_name(src),
                "content": file.content,
                "contentType": content_type
                    .filter(|value| !value.trim().is_empty())
                    .map(String::from)
                    .or_else(|| file.content_type.clone())
                    .unwrap_or_else(|| content_type_of(src).to_string()),
            }))
        };
        let body = &mut request["body"];
        match body["mode"].as_str() {
            Some("formdata") => {
                for row in body["formdata"].as_array_mut().into_iter().flatten() {
                    if !is_file(row) {
                        continue;
                    }
                    let content_type = row["contentType"].as_str().map(String::from);
                    let attached: Vec<Value> = sources(&row["src"])
                        .iter()
                        .filter_map(|src| take(src, content_type.as_deref()))
                        .collect();
                    if !attached.is_empty() {
                        row[ATTACHED] = Value::Array(attached);
                    }
                }
            }
            Some("file") => {
                let src = body["file"]["src"].as_str().unwrap_or_default().to_string();
                if let Some(file) = take(&src, None) {
                    body["file"][ATTACHED] = json!([file]);
                }
            }
            _ => {}
        }
    }
}

/// The request without the contents `attach` added, to return or keep.
pub fn without_contents(mut request: Value) -> Value {
    let body = &mut request["body"];
    for row in body["formdata"].as_array_mut().into_iter().flatten() {
        if let Some(row) = row.as_object_mut() {
            row.remove(ATTACHED);
        }
    }
    if let Some(file) = body["file"].as_object_mut() {
        file.remove(ATTACHED);
    }
    request
}

/// A form-data row that sends files rather than text.
pub fn is_file(row: &Value) -> bool {
    row["type"] == "file"
}

/// The names a file row references: Postman's `src` is a path, a list of paths or empty.
pub fn sources(src: &Value) -> Vec<String> {
    match src {
        Value::String(src) if !src.trim().is_empty() => vec![src.clone()],
        Value::Array(items) => items
            .iter()
            .filter_map(Value::as_str)
            .filter(|src| !src.trim().is_empty())
            .map(String::from)
            .collect(),
        _ => Vec::new(),
    }
}

/// A file part or binary body ready to send: its name, type and bytes.
pub struct Part {
    pub name: String,
    pub content_type: String,
    pub bytes: Vec<u8>,
}

/// The files `attach` gave a form-data row or a binary body (`body.file`).
pub fn attached(value: &Value) -> Result<Vec<Part>> {
    value[ATTACHED]
        .as_array()
        .into_iter()
        .flatten()
        .map(|file| {
            Ok(Part {
                name: file["name"].as_str().unwrap_or("file").to_string(),
                content_type: file["contentType"]
                    .as_str()
                    .unwrap_or("application/octet-stream")
                    .to_string(),
                bytes: STANDARD
                    .decode(file["content"].as_str().unwrap_or_default())
                    .map_err(|_| Error::Validation("A file is not valid base64".into()))?,
            })
        })
        .collect()
}

/// The last segment of a path, as browsers send a file name.
pub fn file_name(src: &str) -> &str {
    src.rsplit(['/', '\\']).next().unwrap_or(src)
}

/// The media type of a file name, as Postman guesses it from the extension.
pub fn content_type_of(src: &str) -> &'static str {
    let extension = file_name(src)
        .rsplit_once('.')
        .map(|(_, extension)| extension.to_ascii_lowercase())
        .unwrap_or_default();
    match extension.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "ico" => "image/x-icon",
        "pdf" => "application/pdf",
        "json" => "application/json",
        "xml" => "application/xml",
        "zip" => "application/zip",
        "gz" => "application/gzip",
        "txt" | "log" => "text/plain",
        "csv" => "text/csv",
        "html" | "htm" => "text/html",
        "css" => "text/css",
        "js" | "mjs" => "text/javascript",
        "yaml" | "yml" => "application/yaml",
        "mp3" => "audio/mpeg",
        "mp4" => "video/mp4",
        "wav" => "audio/wav",
        "doc" => "application/msword",
        "docx" => "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "xls" => "application/vnd.ms-excel",
        "xlsx" => "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        _ => "application/octet-stream",
    }
}

#[cfg(test)]
mod tests;
