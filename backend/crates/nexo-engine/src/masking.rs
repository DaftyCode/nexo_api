//! `mask.apply`: documents or rows masked with a set of rules (`nexo_domain::masking`). The
//! hashes and synthetic values are an HMAC-SHA256 with a key of each workspace, made the
//! first time and kept in the vault under a reserved name: the same value gives the same
//! token in every export of the workspace, and the key never leaves the engine.
use crate::vault::Vault;
use aws_lc_rs::hmac;
use nexo_domain::{
    Error, Result,
    masking::{Masker, Rules},
};
use serde_json::{Value, json};
use tokio::sync::Mutex;

const PREFIX: &str = "nexo-masking:";
/// Values masked by one call, at most.
pub const MAX_VALUES: usize = 10_000;

/// Names of the vault the engine keeps for itself: never read, changed or listed by name.
pub fn is_reserved(name: &str) -> bool {
    name.trim().starts_with(PREFIX)
}

/// Makes the first key of a workspace only once when several calls come together.
static CREATING: Mutex<()> = Mutex::const_new(());

/// The key of a workspace's masking, made the first time.
async fn key(vault: &Vault, workspace: &str) -> Result<hmac::Key> {
    let name = format!("{PREFIX}{workspace}");
    let _creating = CREATING.lock().await;
    let secret = match vault.get(&name).await {
        Ok(secret) => secret,
        Err(_) => {
            let mut bytes = [0u8; 32];
            aws_lc_rs::rand::fill(&mut bytes)
                .map_err(|_| Error::Infrastructure("No randomness for the masking key".into()))?;
            let secret = crate::hex::encode(bytes);
            vault.put(&name, &secret).await?;
            secret
        }
    };
    Ok(hmac::Key::new(hmac::HMAC_SHA256, secret.as_bytes()))
}

/// Masks `documents`, or `rows` with their `columns`, with `rules`.
pub async fn apply(vault: &Vault, payload: &Value) -> Result<Value> {
    let rules = Rules::read(&json!({ "rules": payload["rules"] }))?;
    let key = key(vault, payload["workspace"].as_str().unwrap_or("local")).await?;
    let digest = |input: &[u8]| -> [u8; 32] {
        let mut out = [0u8; 32];
        out.copy_from_slice(hmac::sign(&key, input).as_ref());
        out
    };
    let masker = Masker::new(&rules, &digest);
    if let Some(documents) = payload["documents"].as_array() {
        if documents.len() > MAX_VALUES {
            return Err(too_many());
        }
        let mut documents = documents.clone();
        documents
            .iter_mut()
            .for_each(|document| masker.document(document));
        return Ok(json!({ "documents": documents }));
    }
    let columns: Vec<String> = payload["columns"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|name| name.as_str().unwrap_or_default().to_string())
        .collect();
    let rows = payload["rows"].as_array().cloned().unwrap_or_default();
    if rows.len() > MAX_VALUES {
        return Err(too_many());
    }
    let mut rows = rows
        .into_iter()
        .map(|row| match row {
            Value::Array(cells) if cells.len() == columns.len() => Ok(cells),
            _ => Err(Error::Validation(
                "Each row has a value for each column".into(),
            )),
        })
        .collect::<Result<Vec<_>>>()?;
    let kept = masker.rows(&columns, &mut rows);
    Ok(json!({ "kept": kept, "rows": rows }))
}

fn too_many() -> Error {
    Error::Validation(format!(
        "Mask at most {MAX_VALUES} documents or rows at a time"
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn vault() -> (Vault, std::path::PathBuf) {
        let directory = std::env::temp_dir().join(format!("nexo-masking-{}", uuid::Uuid::new_v4()));
        (Vault::new(directory.clone(), [7; 32], "local"), directory)
    }

    #[tokio::test]
    async fn masks_with_a_key_of_each_workspace_kept_in_the_vault() {
        let (vault, directory) = vault();
        let rules =
            json!([{"path": "email", "method": "hash"}, {"path": "secret", "method": "remove"}]);
        let payload = |workspace: &str| json!({"workspace": workspace, "rules": rules, "documents": [{"email": "ana@corp.com", "secret": 1, "id": 7}]});
        let first = apply(&vault, &payload("local")).await.unwrap();
        let again = apply(&vault, &payload("local")).await.unwrap();
        let other = apply(&vault, &payload("team")).await.unwrap();
        let document = &first["documents"][0];
        assert_eq!(document["id"], 7);
        assert!(document.get("secret").is_none());
        assert_eq!(document["email"].as_str().unwrap().len(), 16);
        assert_eq!(first, again);
        assert_ne!(first, other);
        assert_eq!(vault.get("nexo-masking:local").await.unwrap().len(), 64);
        std::fs::remove_dir_all(directory).ok();
    }

    #[tokio::test]
    async fn masks_rows_and_says_which_columns_stay() {
        let (vault, directory) = vault();
        let payload = json!({
            "workspace": "local",
            "rules": [{"path": "card", "method": "truncate"}, {"path": "pin", "method": "remove"}],
            "columns": ["id", "card", "pin"],
            "rows": [[1, "4111111111111234", "0000"]],
        });
        let masked = apply(&vault, &payload).await.unwrap();
        assert_eq!(masked, json!({"kept": [0, 1], "rows": [[1, "**** 1234"]]}));
        let mut wrong = payload.clone();
        wrong["rows"] = json!([[1, 2]]);
        assert!(apply(&vault, &wrong).await.is_err());
        let mut many = payload.clone();
        many["documents"] = json!(vec![json!({}); MAX_VALUES + 1]);
        assert!(apply(&vault, &many).await.is_err());
        assert!(is_reserved(" nexo-masking:local") && !is_reserved("api-key"));
        std::fs::remove_dir_all(directory).ok();
    }
}
