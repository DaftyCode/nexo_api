//! What a run reads: JSON files, the files it attaches and the engine it calls.
use super::*;

pub(super) fn read_json(path: &str) -> Result<Value, Box<dyn std::error::Error>> {
    let text = std::fs::read_to_string(path).map_err(|e| format!("Cannot read {path}: {e}"))?;
    Ok(serde_json::from_str(&text).map_err(|e| format!("{path} is not valid JSON: {e}"))?)
}
/// The files a collection or request sends (form-data `file` fields and binary bodies), read
/// from `folder` when their paths are relative, as `files` for the engine. A request uses each
/// entry once, so a name referenced twice in one request is sent twice.
pub(super) fn files(source: &Value, folder: &Path) -> Value {
    fn requests<'a>(node: &'a Value, found: &mut Vec<&'a Value>) {
        if let Some(items) = node["item"].as_array() {
            items.iter().for_each(|item| requests(item, found));
        }
        if node["request"].is_object() {
            found.push(&node["request"]);
        } else if node["body"].is_object() {
            found.push(node);
        }
    }
    let mut found = Vec::new();
    requests(source, &mut found);
    let mut needed: Vec<(String, usize)> = Vec::new();
    for request in found {
        let body = &request["body"];
        let mut names: Vec<String> = match body["mode"].as_str() {
            Some("formdata") => body["formdata"]
                .as_array()
                .into_iter()
                .flatten()
                .filter(|row| nexo_engine::files::is_file(row) && row["disabled"] != true)
                .flat_map(|row| nexo_engine::files::sources(&row["src"]))
                .collect(),
            Some("file") => nexo_engine::files::sources(&body["file"]["src"]),
            _ => Vec::new(),
        };
        names.sort();
        for name in names.chunk_by(|a, b| a == b) {
            match needed.iter_mut().find(|(src, _)| src == &name[0]) {
                Some((_, count)) => *count = (*count).max(name.len()),
                None => needed.push((name[0].clone(), name.len())),
            }
        }
    }
    let mut read: HashMap<String, String> = HashMap::new();
    let mut entries = Vec::new();
    for (src, count) in needed {
        let path = folder.join(&src);
        let content = match read.get(&src) {
            Some(content) => content.clone(),
            None => match std::fs::read(&path) {
                Ok(bytes) => {
                    let content = STANDARD.encode(bytes);
                    read.insert(src.clone(), content.clone());
                    content
                }
                // The request reports the file it could not send.
                Err(error) => {
                    eprintln!("Cannot read {}: {error}", path.display());
                    continue;
                }
            },
        };
        for _ in 0..count {
            entries.push(json!({"src": src, "content": content}));
        }
    }
    Value::Array(entries)
}

/// Runs an operation with its payload checked as the API checks it.
pub(super) async fn execute(
    engine: &Engine,
    operation: Operation,
    payload: Value,
) -> Result<Value, nexo_domain::Error> {
    engine
        .execute(operation, payloads::validate(operation, payload)?)
        .await
}
