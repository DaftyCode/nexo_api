//! The AI assistant (IA-01): the key of the provider comes from the vault, under the
//! provider's name (`ai:anthropic`), and never from the interface; what is sent never carries
//! a value of the vault, replaced by `[redacted]`, as in the history. The tools the model
//! reads with run here (`ai.tool`, see tools.rs) and their answers go back to the engine
//! with `ai.continue`.
mod tools;

use crate::{
    Application,
    operations::Operation,
    vault::{redact_error, redact_secrets},
};
use nexo_domain::{Error, Result, ai::Provider};
use serde_json::{Map, Value, json};

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

    fn local_model(&self) -> Result<&std::sync::Arc<dyn crate::ports::LocalModel>> {
        self.local_model
            .as_ref()
            .ok_or_else(|| Error::Unavailable("This Nexo cannot run a local model".into()))
    }

    /// `ai.local.*`: the model run inside Nexo.
    async fn local(&self, operation: Operation, payload: &Map<String, Value>) -> Result<Value> {
        let local = self.local_model()?;
        let text = |name: &str| payload.get(name).and_then(Value::as_str).map(String::from);
        let status = match operation {
            Operation::AiLocalInstall => local.install(text("model")).await?,
            Operation::AiLocalFile => local.use_file(text("path").unwrap_or_default()).await?,
            Operation::AiLocalRemove => local.remove().await?,
            _ => local.status().await?,
        };
        Ok(json!(status))
    }

    /// `ai.models`, `ai.chat`, `ai.poll`, `ai.stop` and `ai.local.*`.
    pub(crate) async fn ai(
        &self,
        operation: Operation,
        mut payload: Map<String, Value>,
    ) -> Result<Value> {
        if matches!(
            operation,
            Operation::AiLocalStatus
                | Operation::AiLocalInstall
                | Operation::AiLocalFile
                | Operation::AiLocalRemove
        ) {
            return self.local(operation, &payload).await;
        }
        if operation == Operation::AiTool {
            // Boxed: a tool runs operations of the databases, which come back through here.
            return Box::pin(self.ai_tool(&payload)).await;
        }
        if operation == Operation::AiContinue {
            // What the tools gave, without a value of the vault, as everything sent.
            let values = self.vault_values().await?;
            if let Some(results) = payload.remove("results") {
                payload.insert("results".into(), redact_secrets(results, &values));
            }
        }
        if matches!(
            operation,
            Operation::AiPoll | Operation::AiStop | Operation::AiContinue
        ) {
            return self
                .executor
                .execute(operation, Value::Object(payload))
                .await;
        }
        // The tools of the place the person asks from: `request`, `sql` or `mongo`.
        if let Some(place) = payload
            .get("tools")
            .and_then(Value::as_str)
            .map(String::from)
        {
            payload.insert("tools".into(), Value::Array(tools::catalog(&place)));
        }
        let provider = Provider::parse(
            payload
                .get("provider")
                .and_then(Value::as_str)
                .unwrap_or_default(),
        )?;
        if provider == Provider::Local {
            // The server of the model, started now if it is not running: its address on
            // loopback, the key of this start and its port, which the egress policy allows.
            let endpoint = self.local_model()?.endpoint().await?;
            payload.insert("baseUrl".into(), Value::String(endpoint.url));
            payload.insert("egressLoopbackPorts".into(), json!([endpoint.port]));
            payload.remove("route");
            payload.remove("caPem");
            let values = self.vault_values().await?;
            for field in ["messages", "system"] {
                if let Some(value) = payload.remove(field) {
                    payload.insert(field.into(), redact_secrets(value, &values));
                }
            }
            payload.insert("resolvedKey".into(), Value::String(endpoint.token));
            return self
                .executor
                .execute(operation, Value::Object(payload))
                .await
                .map_err(|error| redact_error(error, &values));
        }
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
