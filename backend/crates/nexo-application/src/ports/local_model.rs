//! The model run inside Nexo (IA-01): llama.cpp's server and a GGUF, downloaded and checked
//! against the hashes Nexo carries, started on loopback when the assistant needs it and
//! stopped when nobody uses it.
use async_trait::async_trait;
use nexo_domain::Result;
use serde::Serialize;

/// A device the engine can run on, with its memory in MiB.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalDevice {
    pub id: String,
    pub name: String,
    pub total_mib: u64,
    pub free_mib: u64,
}

/// Where the local model stands, and what this computer has.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalStatus {
    /// `cuda`, `vulkan`, `metal` or `cpu`: what the engine installed uses, or would use.
    pub backend: String,
    /// The engine is installed.
    pub engine: bool,
    /// The model installed: an id of the catalog, `file` for one of the person's own, or
    /// none.
    pub model: Option<String>,
    /// The name of the model installed or of the file.
    pub model_name: Option<String>,
    /// Bytes the engine and the recommended model take to download, before downloading.
    pub engine_size: u64,
    pub model_size: u64,
    /// The model this computer runs best, and why (`ai.local.why.*`); an error when even
    /// the smallest does not fit.
    pub recommended: Option<String>,
    pub reason: Option<String>,
    pub devices: Vec<LocalDevice>,
    /// The GPU chosen, by its id.
    pub device: Option<String>,
    pub ram_free_mib: u64,
    /// The server runs now, with what `--fit` chose when it loaded.
    pub running: bool,
    pub gpu_layers: Option<String>,
    pub context: Option<u64>,
    /// An installation in progress.
    pub installing: bool,
    pub received: u64,
    pub total: u64,
    /// Why the last installation or start failed.
    pub error: Option<String>,
}

/// The server of the model: where it listens on loopback and the key of this start.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LocalEndpoint {
    pub url: String,
    pub port: u16,
    pub token: String,
}

#[async_trait]
pub trait LocalModel: Send + Sync {
    async fn status(&self) -> Result<LocalStatus>;
    /// Starts downloading the engine and a model (`model` of the catalog, or the one this
    /// computer runs best), and answers how it starts; `status` follows it.
    async fn install(&self, model: Option<String>) -> Result<LocalStatus>;
    /// Uses a GGUF of the person's own, by its path on this computer, instead of a download.
    async fn use_file(&self, path: String) -> Result<LocalStatus>;
    /// Deletes the model and the engine, stopping the server.
    async fn remove(&self) -> Result<LocalStatus>;
    /// The server of the model, started when it is not running.
    async fn endpoint(&self) -> Result<LocalEndpoint>;
}
