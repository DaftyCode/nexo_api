use crate::infrastructure as err;
use async_trait::async_trait;
use nexo_application::ports::ExecutionGateway;
use nexo_domain::{Actor, Error, Result};
use serde_json::{Value, json};
use std::{path::PathBuf, process::Stdio};
use tokio::{
    io::{AsyncBufReadExt, BufReader},
    process::{Child, Command},
    sync::Mutex,
};
use uuid::Uuid;

pub struct NodeExecutor {
    url: String,
    token: String,
    client: reqwest::Client,
    _child: Mutex<Child>,
}
impl NodeExecutor {
    pub async fn spawn(
        node: PathBuf,
        script: PathBuf,
        data: PathBuf,
        master_key: Option<String>,
    ) -> Result<Self> {
        let token = format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
        let mut command = Command::new(node);
        command
            .arg(script)
            .env("NEXO_ENGINE_TOKEN", &token)
            .env("NEXO_DATA_DIR", data)
            .env("NEXO_ENGINE_PORT", "0")
            .env("NEXO_PARENT_PIPE", "1")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .kill_on_drop(true);
        if let Some(master) = master_key {
            command.env("NEXO_MASTER_KEY", master);
        }
        #[cfg(windows)]
        command.creation_flags(0x08000000);
        let mut child = command.spawn().map_err(err)?;
        let mut lines = BufReader::new(
            child
                .stdout
                .take()
                .ok_or_else(|| err("Missing engine stdout"))?,
        )
        .lines();
        let port = tokio::time::timeout(std::time::Duration::from_secs(30), async {
            while let Some(line) = lines.next_line().await.map_err(err)? {
                if let Some(port) = line.strip_prefix("NEXO_ENGINE_READY:") {
                    return port.parse::<u16>().map_err(err);
                }
            }
            Err(err("Compatibility engine failed to start"))
        })
        .await
        .map_err(err)??;
        tokio::spawn(async move { while let Ok(Some(_)) = lines.next_line().await {} });
        Ok(Self {
            url: format!("http://127.0.0.1:{port}"),
            token,
            client: reqwest::Client::builder()
                .timeout(std::time::Duration::from_secs(130))
                .build()
                .map_err(err)?,
            _child: Mutex::new(child),
        })
    }
    pub async fn dispatch(&self, actor: &Actor, operation: &str, payload: Value) -> Result<Value> {
        let response = self
            .client
            .post(format!("{}/execute", self.url))
            .bearer_auth(&self.token)
            .json(&json!({"actor":actor.id,"operation":operation,"payload":payload}))
            .send()
            .await
            .map_err(err)?;
        let status = response.status();
        let body: Value = response.json().await.map_err(err)?;
        if !status.is_success() {
            return Err(Error::Validation(
                body["error"].as_str().unwrap_or("Execution failed").into(),
            ));
        }
        Ok(body.get("result").cloned().unwrap_or(Value::Null))
    }
}
#[async_trait]
impl ExecutionGateway for NodeExecutor {
    async fn execute(&self, actor: &Actor, operation: &str, payload: Value) -> Result<Value> {
        self.dispatch(actor, operation, payload).await
    }
}
