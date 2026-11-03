use crate::{executor::NodeExecutor, infrastructure as err};
use async_trait::async_trait;
use nexo_application::ports::SecretVault;
use nexo_domain::{Actor, Result};
use serde_json::json;
use std::sync::Arc;

/// Server secrets are AES-GCM encrypted by the private adapter. Desktop master keys
/// are stored in the OS credential store; server administrators can mount a master key.
pub struct VaultAdapter {
    executor: Arc<NodeExecutor>,
}
impl VaultAdapter {
    pub fn new(executor: Arc<NodeExecutor>) -> Self {
        Self { executor }
    }
}
#[async_trait]
impl SecretVault for VaultAdapter {
    async fn put(&self, actor: &Actor, name: &str, value: &str) -> Result<()> {
        self.executor
            .dispatch(actor, "vault.put", json!({"name":name,"value":value}))
            .await?;
        Ok(())
    }
    async fn remove(&self, actor: &Actor, name: &str) -> Result<()> {
        self.executor
            .dispatch(actor, "vault.remove", json!({"name":name}))
            .await?;
        Ok(())
    }
    async fn resolve(&self, actor: &Actor, name: &str) -> Result<String> {
        let value = self
            .executor
            .dispatch(actor, "vault.get", json!({"name":name}))
            .await?;
        value["value"]
            .as_str()
            .map(String::from)
            .ok_or_else(|| err("Invalid vault response"))
    }
}
pub fn desktop_master_key() -> Result<String> {
    let entry = keyring::Entry::new("Nexo API", "master-key").map_err(err)?;
    match entry.get_password() {
        Ok(value) => Ok(value),
        Err(keyring::Error::NoEntry) => {
            let key = format!(
                "{}{}",
                uuid::Uuid::new_v4().simple(),
                uuid::Uuid::new_v4().simple()
            );
            entry.set_password(&key).map_err(err)?;
            Ok(key)
        }
        Err(error) => Err(err(error)),
    }
}
