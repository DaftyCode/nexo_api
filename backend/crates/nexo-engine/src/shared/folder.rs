//! A shared collection in a folder: a synced folder or a network drive. Read whole, written
//! at once (to a file beside it, then renamed over it) only when nobody changed it since the
//! version the application read, and looked at by its size and time of change, a check that
//! never leaves this computer.
use super::{decode, encode, version};
use nexo_domain::{Error, Result, shared};
use serde_json::{Map, Value, json};
use std::{
    io::ErrorKind,
    path::{Path, PathBuf},
    time::UNIX_EPOCH,
};

fn path(payload: &Value) -> Result<PathBuf> {
    let text = payload["location"]["path"]
        .as_str()
        .unwrap_or_default()
        .trim();
    if !shared::is_shared_file(text) {
        return Err(Error::Validation(format!(
            "A shared collection is a file ending in {}",
            shared::EXTENSION
        )));
    }
    Ok(PathBuf::from(text))
}

fn io(error: std::io::Error) -> Error {
    match error.kind() {
        ErrorKind::PermissionDenied => {
            Error::Validation("Nexo may not read or write the shared collection there".into())
        }
        ErrorKind::NotFound => {
            Error::Validation("The folder of the shared collection is not there".into())
        }
        _ => Error::Infrastructure(error.to_string()),
    }
}

/// What tells two versions of a file apart, without reading it: its size and time of change.
fn stamp(path: &Path) -> Option<String> {
    let metadata = std::fs::metadata(path).ok()?;
    let changed = metadata
        .modified()
        .ok()?
        .duration_since(UNIX_EPOCH)
        .ok()?
        .as_nanos();
    Some(format!("{}-{changed}", metadata.len()))
}

/// `shared.read`: the content of the file, opened with `resolvedKey` when it is sealed
/// (`locked` without it), its version and its stamp; `found: false` when it is not there.
pub(super) fn read(payload: &Value) -> Result<Value> {
    let path = path(payload)?;
    let bytes = match std::fs::read(&path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(json!({"found": false})),
        Err(error) => return Err(io(error)),
    };
    let mut answer = decode(&bytes, payload)?;
    answer["version"] = json!(version(&bytes));
    answer["stamp"] = json!(stamp(&path));
    Ok(answer)
}

/// `shared.write`: writes `content`, sealed with `resolvedKey` when there is one, if the
/// file is still at version `expected` (or not there, when none is expected).
pub(super) fn write(payload: &Value) -> Result<Value> {
    let path = path(payload)?;
    let current = match std::fs::read(&path) {
        Ok(bytes) => Some(version(&bytes)),
        Err(error) if error.kind() == ErrorKind::NotFound => None,
        Err(error) => return Err(io(error)),
    };
    let expected = payload["expected"].as_str();
    if current.is_some() && current.as_deref() != expected {
        return Err(Error::Conflict);
    }
    let file = encode(payload)?;
    let mut beside = path.clone().into_os_string();
    beside.push(".nexo-writing");
    let beside = PathBuf::from(beside);
    std::fs::write(&beside, &file).map_err(io)?;
    if let Err(error) = std::fs::rename(&beside, &path) {
        let _ = std::fs::remove_file(&beside);
        return Err(io(error));
    }
    Ok(json!({"version": version(&file), "stamp": stamp(&path)}))
}

/// `shared.stat`: the stamp of each file, `null` when it is not there.
pub fn stat(payload: &Value) -> Result<Value> {
    let mut stamps = Map::new();
    for path in payload["paths"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
    {
        if shared::is_shared_file(path) {
            stamps.insert(path.into(), json!(stamp(Path::new(path))));
        }
    }
    Ok(json!({"stamps": stamps}))
}
