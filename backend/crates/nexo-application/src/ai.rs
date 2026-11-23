//! The AI assistant (IA-01): the key of the provider comes from the vault, under the
//! provider's name (`ai:anthropic`), and never from the interface; what is sent never carries
//! a value of the vault, replaced by `[redacted]`, as in the history.
use crate::{
    Application,
    operations::Operation,
    vault::{redact_error, redact_secrets},
};
use nexo_domain::{Error, Result, ai::Provider};
use serde_json::{Map, Value};

impl Application {
    /// The values of the vault, to take out of what leaves: every secret, the key included.
    async fn vault_values(&self) -> Result<Vec<(String, String)>> {
        let mut values = Vec::new();
        for secret in self.secrets.secrets().await? {
            if let Ok(value) = self.secrets.resolve(&secret.name).await {
                values.push((secret.name, value));
            }
        }
        Ok(values)
    }

    /// `ai.models`, `ai.chat`, `ai.poll` and `ai.stop`.
    pub(crate) async fn ai(
        &self,
        operation: Operation,
        mut payload: Map<String, Value>,
    ) -> Result<Value> {
        if matches!(operation, Operation::AiPoll | Operation::AiStop) {
            return self
                .executor
                .execute(operation, Value::Object(payload))
                .await;
        }
        let provider = Provider::parse(
            payload
                .get("provider")
                .and_then(Value::as_str)
                .unwrap_or_default(),
        )?;
        let key = match self.secrets.resolve(&provider.key_name()).await {
            Ok(key) => Some(key),
            Err(_) if !provider.needs_key() => None,
            Err(_) => {
                return Err(Error::Validation(
                    "Paste the API key of the provider in Settings → AI assistant".into(),
                ));
            }
        };
        let values = self.vault_values().await?;
        // The words of the conversation and the instructions, without a secret of the vault.
        for field in ["messages", "system"] {
            if let Some(value) = payload.remove(field) {
                payload.insert(field.into(), redact_secrets(value, &values));
            }
        }
        // A proxy or an SSH tunnel of a profile, with its secrets (see ssh.rs).
        let workspace = payload
            .get("workspace")
            .and_then(Value::as_str)
            .map(String::from);
        if let Some(profiles) = self
            .ssh_profiles(workspace.as_deref(), &Value::Object(payload.clone()))
            .await?
        {
            payload.insert("sshProfiles".into(), profiles);
        }
        if let Some(key) = key {
            payload.insert("resolvedKey".into(), Value::String(key));
        }
        self.executor
            .execute(operation, Value::Object(payload))
            .await
            .map_err(|error| redact_error(error, &values))
    }
}

#[cfg(test)]
mod tests;
