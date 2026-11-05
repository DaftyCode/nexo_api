//! OAuth 2.0 tokens kept in the encrypted vault, Postman's "Available Tokens".
//!
//! Each token has three vault entries: its access token and its ID token, which requests
//! reference as `{{vault:nexo-oauth2:<id>}}` / `{{vault:nexo-oauth2-id:<id>}}` so they are
//! resolved and redacted like any secret, and its details (name, expiry, refresh token).
//! Collections only store the reference and the token id, never the token.
use nexo_domain::{Error, Result};
use serde_json::{Value, json};

use crate::{auth::text, vault::Vault};

const PREFIX: &str = "nexo-oauth2";
const ACCESS: &str = "nexo-oauth2:";
const IDENTITY: &str = "nexo-oauth2-id:";
const DETAILS: &str = "nexo-oauth2-details:";

/// Vault names reserved for tokens: hidden from the secrets list and not editable there.
pub fn is_reserved(name: &str) -> bool {
    name.trim().starts_with(PREFIX)
}

fn invalid(message: impl Into<String>) -> Error {
    Error::Validation(message.into())
}

/// The variable a request uses for a stored token: its access token or, with
/// `id_token`, its ID token.
pub fn reference(id: &str, source: &str) -> String {
    if source == "id_token" {
        format!("{{{{vault:{IDENTITY}{id}}}}}")
    } else {
        format!("{{{{vault:{ACCESS}{id}}}}}")
    }
}

/// What the interface may see of a token: no token values.
fn public(details: &Value) -> Value {
    let id = details["id"].as_str().unwrap_or_default();
    json!({
        "id": id,
        "name": details["name"],
        "tokenType": details["tokenType"],
        "scope": details["scope"],
        "expiresAt": details["expiresAt"],
        "obtainedAt": details["obtainedAt"],
        "hasRefreshToken": details["refreshToken"].as_str().is_some_and(|t| !t.is_empty()),
        "hasIdToken": details["idToken"].as_str().is_some_and(|t| !t.is_empty()),
        "reference": reference(id, "access_token"),
        "idReference": reference(id, "id_token"),
    })
}

async fn write(vault: &Vault, id: &str, details: &Value) -> Result<Value> {
    let access = details["accessToken"]
        .as_str()
        .or_else(|| details["idToken"].as_str())
        .unwrap_or_default();
    vault.put(&format!("{ACCESS}{id}"), access).await?;
    match details["idToken"].as_str().filter(|t| !t.is_empty()) {
        Some(identity) => vault.put(&format!("{IDENTITY}{id}"), identity).await?,
        None => {
            let _ = vault.remove(&format!("{IDENTITY}{id}")).await;
        }
    }
    vault
        .put(&format!("{DETAILS}{id}"), &details.to_string())
        .await?;
    Ok(public(details))
}

/// Keeps a token answer (from `oauth2::token_response`) under `name`.
pub async fn store(vault: &Vault, name: &str, token: &Value) -> Result<Value> {
    let id = uuid::Uuid::new_v4().simple().to_string();
    let mut details = token.clone();
    details["id"] = json!(id);
    details["name"] = json!(if name.trim().is_empty() {
        "Token"
    } else {
        name.trim()
    });
    write(vault, &id, &details).await
}

/// Replaces a token after a refresh, keeping its name and, when the answer has none, its
/// refresh token.
pub async fn replace(vault: &Vault, id: &str, token: &Value) -> Result<Value> {
    let previous = details(vault, id).await?;
    let mut next = token.clone();
    next["id"] = json!(id);
    next["name"] = previous["name"].clone();
    if text(next.get("refreshToken")).is_empty() {
        next["refreshToken"] = previous["refreshToken"].clone();
    }
    write(vault, id, &next).await
}

/// Every detail of a token, including its values: for refreshing and for "Manage Tokens".
pub async fn details(vault: &Vault, id: &str) -> Result<Value> {
    let text = vault
        .get(&format!("{DETAILS}{id}"))
        .await
        .map_err(|_| invalid("This token no longer exists"))?;
    serde_json::from_str(&text).map_err(|_| invalid("This token is damaged; delete it"))
}

/// The stored tokens, newest first, without their values.
pub async fn list(vault: &Vault) -> Result<Vec<Value>> {
    let mut tokens = Vec::new();
    for name in vault.names().await? {
        if let Some(id) = name.strip_prefix(DETAILS)
            && let Ok(details) = details(vault, id).await
        {
            tokens.push(public(&details));
        }
    }
    tokens.sort_by_key(|token| std::cmp::Reverse(token["obtainedAt"].as_u64().unwrap_or(0)));
    Ok(tokens)
}

pub async fn delete(vault: &Vault, id: &str) -> Result<()> {
    for prefix in [ACCESS, IDENTITY, DETAILS] {
        let _ = vault.remove(&format!("{prefix}{id}")).await;
    }
    Ok(())
}

/// Values of every stored token by name, for `{{$oauth2.<name>.access_token}}` (Bruno's
/// syntax), `.id_token` and `.refresh_token`.
pub async fn variables(vault: &Vault) -> Result<serde_json::Map<String, Value>> {
    let mut variables = serde_json::Map::new();
    for name in vault.names().await? {
        let Some(id) = name.strip_prefix(DETAILS) else {
            continue;
        };
        let Ok(details) = details(vault, id).await else {
            continue;
        };
        let token_name = text(details.get("name"));
        for (field, key) in [
            ("accessToken", "access_token"),
            ("idToken", "id_token"),
            ("refreshToken", "refresh_token"),
        ] {
            if let Some(value) = details[field].as_str().filter(|v| !v.is_empty()) {
                variables.insert(format!("$oauth2.{token_name}.{key}"), json!(value));
            }
        }
    }
    Ok(variables)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn vault() -> Vault {
        let directory = std::env::temp_dir().join(format!("nexo-tokens-{}", uuid::Uuid::new_v4()));
        Vault::new(directory, [7; 32], "local")
    }

    #[tokio::test]
    async fn stores_lists_refreshes_and_deletes_tokens_without_exposing_values() {
        let vault = vault();
        let token = json!({"accessToken": "access-one", "idToken": "i1", "refreshToken": "r1",
                           "expiresAt": 10, "obtainedAt": 1});
        let stored = store(&vault, "GOOD", &token).await.unwrap();
        let id = stored["id"].as_str().unwrap().to_string();
        assert!(!stored.to_string().contains("access-one"));
        assert_eq!(stored["hasRefreshToken"], true);
        assert_eq!(
            stored["reference"],
            format!("{{{{vault:nexo-oauth2:{id}}}}}")
        );
        assert_eq!(
            vault.get(&format!("nexo-oauth2:{id}")).await.unwrap(),
            "access-one"
        );
        assert_eq!(
            vault.get(&format!("nexo-oauth2-id:{id}")).await.unwrap(),
            "i1"
        );
        assert_eq!(list(&vault).await.unwrap().len(), 1);
        assert_eq!(
            variables(&vault).await.unwrap()["$oauth2.GOOD.access_token"],
            "access-one"
        );

        // A refresh without a new refresh token keeps the previous one and the name.
        replace(
            &vault,
            &id,
            &json!({"accessToken": "a2", "expiresAt": 20, "obtainedAt": 2}),
        )
        .await
        .unwrap();
        let current = details(&vault, &id).await.unwrap();
        assert_eq!(current["accessToken"], "a2");
        assert_eq!(current["refreshToken"], "r1");
        assert_eq!(current["name"], "GOOD");
        assert_eq!(vault.get(&format!("nexo-oauth2:{id}")).await.unwrap(), "a2");

        delete(&vault, &id).await.unwrap();
        assert!(list(&vault).await.unwrap().is_empty());
        assert!(vault.names().await.unwrap().is_empty());
    }

    #[test]
    fn token_names_are_reserved() {
        assert!(is_reserved("nexo-oauth2:abc"));
        assert!(is_reserved(" nexo-oauth2-details:abc"));
        assert!(!is_reserved("api-token"));
    }
}
