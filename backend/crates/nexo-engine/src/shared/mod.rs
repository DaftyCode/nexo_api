//! The file of a collection shared by the team (C-01), as the application asks for it:
//! read in the clear or opened with the team key, written whole and at once (to a file
//! beside it, then renamed over it) only when nobody changed it since the version the
//! application read, and looked at by its size and time of change, a check that never
//! leaves this computer. Only `.nexo-collection` files are read or written.
use crate::{hex, vault::rand_bytes};
use aws_lc_rs::{
    aead::{AES_256_GCM, Aad, LessSafeKey, Nonce, UnboundKey},
    digest::{SHA256, digest},
};
use nexo_domain::{
    Error, Result,
    shared::{self, Envelope},
};
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

fn version(bytes: &[u8]) -> String {
    hex::encode(digest(&SHA256, bytes))
}

fn cipher(key: &str) -> Result<LessSafeKey> {
    let key = shared::parse_key(key)?;
    let unbound = UnboundKey::new(&AES_256_GCM, &key)
        .map_err(|_| Error::Infrastructure("AES-256-GCM is unavailable".into()))?;
    Ok(LessSafeKey::new(unbound))
}

fn open(key: &str, nonce: &str, data: &str) -> Result<Value> {
    let refused = || Error::Validation("The team key does not open this shared collection".into());
    let nonce = hex::decode(nonce).ok_or_else(refused)?;
    let mut data = hex::decode(data).ok_or_else(refused)?;
    let nonce = Nonce::try_assume_unique_for_key(&nonce).map_err(|_| refused())?;
    let plain = cipher(key)?
        .open_in_place(nonce, Aad::from(shared::associated_data()), &mut data)
        .map_err(|_| refused())?;
    serde_json::from_slice(plain).map_err(|_| refused())
}

fn seal(key: &str, content: &Value) -> Result<Value> {
    let nonce: [u8; 12] = rand_bytes();
    let mut data =
        serde_json::to_vec(content).map_err(|error| Error::Infrastructure(error.to_string()))?;
    cipher(key)?
        .seal_in_place_append_tag(
            Nonce::assume_unique_for_key(nonce),
            Aad::from(shared::associated_data()),
            &mut data,
        )
        .map_err(|_| Error::Infrastructure("The shared collection could not be sealed".into()))?;
    Ok(shared::sealed(&hex::encode(nonce), &hex::encode(data)))
}

/// `shared.read`: the content of the file, opened with `resolvedKey` when it is sealed
/// (`locked` without it), its version and its stamp; `found: false` when it is not there.
pub fn read(payload: &Value) -> Result<Value> {
    let path = path(payload)?;
    let bytes = match std::fs::read(&path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(json!({"found": false})),
        Err(error) => return Err(io(error)),
    };
    let file: Value = serde_json::from_slice(&bytes)
        .map_err(|_| Error::Validation("This file is not a collection shared by Nexo".into()))?;
    let mut answer = json!({"found": true, "version": version(&bytes), "stamp": stamp(&path)});
    match shared::read(&file)? {
        Envelope::Plain(content) => {
            answer["encrypted"] = json!(false);
            answer["content"] = content;
        }
        Envelope::Sealed { nonce, data } => {
            answer["encrypted"] = json!(true);
            match payload["resolvedKey"].as_str() {
                Some(key) => answer["content"] = open(key, &nonce, &data)?,
                None => answer["locked"] = json!(true),
            }
        }
    }
    Ok(answer)
}

/// `shared.write`: writes `content`, sealed with `resolvedKey` when there is one, if the
/// file is still at version `expected` (or not there, when none is expected).
pub fn write(payload: &Value) -> Result<Value> {
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
    let content = &payload["content"];
    if !content["collection"].is_object() {
        return Err(Error::Validation(
            "A shared collection needs its collection".into(),
        ));
    }
    let file = match payload["resolvedKey"].as_str() {
        Some(key) => serde_json::to_vec(&seal(key, content)?),
        None => serde_json::to_vec_pretty(&shared::plain(content)),
    }
    .map_err(|error| Error::Infrastructure(error.to_string()))?;
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

/// `shared.key.new`: a new team key, as people copy it.
pub fn new_key() -> Value {
    json!({"key": shared::key_text(&rand_bytes())})
}

#[cfg(test)]
mod tests;
