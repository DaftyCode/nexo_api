//! The file of a collection shared by the team (C-01), as the application asks for it: in
//! a folder (folder.rs) or at the URL of a server (remote.rs), read in the clear or opened
//! with the team key, and written only when nobody changed it since the version the
//! application read. Only `.nexo-collection` files are read or written.
mod folder;
mod remote;

use crate::{egress::Policy, hex, vault::rand_bytes};
use aws_lc_rs::{
    aead::{AES_256_GCM, Aad, LessSafeKey, Nonce, UnboundKey},
    digest::{SHA256, digest},
};
use nexo_domain::{
    Error, Result,
    shared::{self, Envelope},
};
use serde_json::{Value, json};

pub use folder::stat;

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

/// What a file holds, opened with `resolvedKey` when it is sealed (`locked` without it).
fn decode(bytes: &[u8], payload: &Value) -> Result<Value> {
    let file: Value = serde_json::from_slice(bytes)
        .map_err(|_| Error::Validation("This file is not a collection shared by Nexo".into()))?;
    let mut answer = json!({"found": true});
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

/// The bytes of the file of `content`: sealed with `resolvedKey` when there is one.
fn encode(payload: &Value) -> Result<Vec<u8>> {
    let content = &payload["content"];
    if !content["collection"].is_object() {
        return Err(Error::Validation(
            "A shared collection needs its collection".into(),
        ));
    }
    match payload["resolvedKey"].as_str() {
        Some(key) => serde_json::to_vec(&seal(key, content)?),
        None => serde_json::to_vec_pretty(&shared::plain(content)),
    }
    .map_err(|error| Error::Infrastructure(error.to_string()))
}

fn is_remote(payload: &Value) -> bool {
    payload["location"]["kind"] == "url"
}

/// `shared.read`: the content of the file, its version and, in a folder, its stamp;
/// `found: false` when it is not there. A server answering that the version `known` did
/// not change sends nothing: `unchanged`.
pub async fn read(payload: &Value, egress: &Policy, ports: &[u16]) -> Result<Value> {
    if is_remote(payload) {
        remote::read(payload, egress, ports).await
    } else {
        folder::read(payload)
    }
}

/// `shared.write`: writes `content`, sealed with `resolvedKey` when there is one, if the
/// file is still at version `expected` (or not there, when none is expected).
pub async fn write(payload: &Value, egress: &Policy, ports: &[u16]) -> Result<Value> {
    if is_remote(payload) {
        remote::write(payload, egress, ports).await
    } else {
        folder::write(payload)
    }
}

/// `shared.key.new`: a new team key, as people copy it.
pub fn new_key() -> Value {
    json!({"key": shared::key_text(&rand_bytes())})
}

#[cfg(test)]
mod tests;
