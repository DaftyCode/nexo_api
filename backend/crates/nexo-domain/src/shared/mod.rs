//! A collection shared by the team (C-01): one file every Nexo of the team reads and writes,
//! kept where the team already keeps its files (a folder Google Drive, OneDrive or Dropbox
//! sync, or a network drive). Its content is the collection and the environments chosen,
//! as they may be shared (credentials masked, secret values left out), in the clear or
//! sealed with a team key that never goes in the file. Two people's changes are joined
//! element by element (`merge`).
mod merge;
mod rows;

pub use merge::{Conflict, Merged, merge};
pub use rows::merge_rows;

use crate::{Error, Result};
use serde_json::{Value, json};

/// What the file says it is, and the version of its format.
pub const FORMAT: &str = "nexo-shared-collection";
pub const VERSION: u64 = 1;
/// The extension of the file: Nexo writes no other.
pub const EXTENSION: &str = ".nexo-collection";
/// The prefix of a team key as people copy it.
const KEY_PREFIX: &str = "nexo-team-key-";

/// The file as it was read: its content, or the sealed content and its nonce (hex).
#[derive(Debug, Clone, PartialEq)]
pub enum Envelope {
    Plain(Value),
    Sealed { nonce: String, data: String },
}

/// The file of a content in the clear.
pub fn plain(content: &Value) -> Value {
    json!({"nexo": FORMAT, "version": VERSION, "content": content})
}

/// The file of a content sealed with AES-256-GCM: the nonce and the ciphertext with its tag.
pub fn sealed(nonce: &str, data: &str) -> Value {
    json!({"nexo": FORMAT, "version": VERSION, "sealed": {"alg": "A256GCM", "nonce": nonce, "data": data}})
}

/// The data sealing binds to: the format and its version.
pub fn associated_data() -> Vec<u8> {
    format!("{FORMAT}:v{VERSION}").into_bytes()
}

/// What a file holds, or why it is not a shared collection Nexo can read.
pub fn read(file: &Value) -> Result<Envelope> {
    if file["nexo"] != FORMAT {
        return Err(Error::Validation(
            "This file is not a collection shared by Nexo".into(),
        ));
    }
    if file["version"]
        .as_u64()
        .is_none_or(|version| version > VERSION)
    {
        return Err(Error::Validation(
            "This shared collection was written by a newer Nexo: update Nexo to open it".into(),
        ));
    }
    if let Some(sealed) = file["sealed"].as_object() {
        let text = |name: &str| sealed.get(name).and_then(Value::as_str).unwrap_or_default();
        if text("alg") != "A256GCM" || text("nonce").is_empty() || text("data").is_empty() {
            return Err(Error::Validation("The shared collection is damaged".into()));
        }
        return Ok(Envelope::Sealed {
            nonce: text("nonce").into(),
            data: text("data").into(),
        });
    }
    if !file["content"]["collection"].is_object() {
        return Err(Error::Validation("The shared collection is damaged".into()));
    }
    Ok(Envelope::Plain(file["content"].clone()))
}

/// A team key as people copy it: the prefix and 32 bytes in hexadecimal.
pub fn key_text(key: &[u8; 32]) -> String {
    let hex: String = key.iter().map(|byte| format!("{byte:02x}")).collect();
    format!("{KEY_PREFIX}{hex}")
}

/// The 32 bytes of a team key, from the text people paste.
pub fn parse_key(text: &str) -> Result<[u8; 32]> {
    let invalid = || Error::Validation("This is not a team key of Nexo".into());
    let hex = text.trim().strip_prefix(KEY_PREFIX).ok_or_else(invalid)?;
    if hex.len() != 64 || !hex.is_ascii() {
        return Err(invalid());
    }
    let mut key = [0u8; 32];
    for (index, byte) in key.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&hex[index * 2..index * 2 + 2], 16).map_err(|_| invalid())?;
    }
    Ok(key)
}

/// Gives an id to every item of a collection that has none, so that two people's changes
/// meet on the same element. Says whether one was given.
pub fn ensure_ids(collection: &mut Value, mut new_id: impl FnMut() -> String) -> bool {
    fn walk(items: &mut Value, new_id: &mut dyn FnMut() -> String) -> bool {
        let mut given = false;
        for item in items.as_array_mut().into_iter().flatten() {
            if item["id"].as_str().is_none_or(str::is_empty) {
                item["id"] = Value::String(new_id());
                given = true;
            }
            if item.get("item").is_some() {
                given |= walk(&mut item["item"], new_id);
            }
        }
        given
    }
    walk(&mut collection["item"], &mut new_id)
}

/// Whether a path names a shared collection file.
pub fn is_shared_file(path: &str) -> bool {
    path.to_ascii_lowercase().ends_with(EXTENSION)
}

#[cfg(test)]
mod tests;
