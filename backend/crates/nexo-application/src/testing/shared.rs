//! The engine's shared files, kept in memory: each path with its content, the team key it
//! was sealed with and its version, as `shared.read`, `shared.write` and `shared.stat` see
//! them. A test plays a teammate by writing a file itself (`Fake::teammate_writes`).
use super::*;
use std::collections::HashMap;

/// A file: its content, the key it was sealed with and its version.
pub(crate) type SharedFile = (Value, Option<String>, u64);

#[derive(Default)]
pub(crate) struct SharedFiles {
    pub(crate) files: HashMap<String, SharedFile>,
    next: u64,
}

impl SharedFiles {
    fn put(&mut self, path: &str, content: Value, key: Option<String>) -> u64 {
        self.next += 1;
        self.files.insert(path.into(), (content, key, self.next));
        self.next
    }
}

fn answer(version: u64) -> Value {
    json!({"version": format!("v{version}"), "stamp": format!("s{version}")})
}

impl Fake {
    /// A teammate's Nexo writes the file: its version changes.
    pub(crate) fn teammate_writes(&self, path: &str, content: Value) {
        let mut shared = self.shared.lock().unwrap();
        let key = shared.files.get(path).and_then(|file| file.1.clone());
        shared.put(path, content, key);
    }

    /// The content of a file now.
    pub(crate) fn shared_file(&self, path: &str) -> Option<SharedFile> {
        self.shared.lock().unwrap().files.get(path).cloned()
    }

    pub(super) fn shared_answer(&self, operation: Operation, payload: &Value) -> Result<Value> {
        let mut shared = self.shared.lock().unwrap();
        let location = &payload["location"];
        let path = location["path"]
            .as_str()
            .or(location["url"].as_str())
            .unwrap_or_default()
            .to_owned();
        let key = payload["resolvedKey"].as_str().map(String::from);
        match operation {
            Operation::SharedRead => {
                let Some((content, sealed, version)) = shared.files.get(&path).cloned() else {
                    return Ok(json!({"found": false}));
                };
                let mut read = answer(version);
                read["found"] = json!(true);
                // A server asked with the version it has sends nothing.
                if location["kind"] == "url" {
                    read["stamp"] = Value::Null;
                    if payload["known"] == read["version"] {
                        return Ok(
                            json!({"found": true, "unchanged": true, "version": read["version"]}),
                        );
                    }
                }
                read["encrypted"] = json!(sealed.is_some());
                match (sealed, key) {
                    (Some(_), None) => read["locked"] = json!(true),
                    (Some(sealed), Some(key)) if sealed != key => {
                        return Err(Error::Validation(
                            "The team key does not open this shared collection".into(),
                        ));
                    }
                    _ => read["content"] = content,
                }
                Ok(read)
            }
            Operation::SharedWrite => {
                let current = shared.files.get(&path).map(|file| format!("v{}", file.2));
                if current.is_some() && current.as_deref() != payload["expected"].as_str() {
                    return Err(Error::Conflict);
                }
                let version = shared.put(&path, payload["content"].clone(), key);
                let mut written = answer(version);
                if location["kind"] == "url" {
                    written["stamp"] = Value::Null;
                }
                Ok(written)
            }
            Operation::SharedStat => {
                let stamps: serde_json::Map<String, Value> = payload["paths"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(Value::as_str)
                    .map(|path| {
                        let stamp = shared
                            .files
                            .get(path)
                            .map(|file| json!(format!("s{}", file.2)));
                        (path.to_owned(), stamp.unwrap_or(Value::Null))
                    })
                    .collect();
                Ok(json!({"stamps": stamps}))
            }
            _ => Ok(json!({"key": format!("nexo-team-key-{}", "ab".repeat(32))})),
        }
    }
}
