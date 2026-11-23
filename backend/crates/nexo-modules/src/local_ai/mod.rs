//! The model run inside Nexo (IA-01), behind the application's `LocalModel` port: llama.cpp's
//! server and a Qwen3.5 GGUF downloaded from the hosts of the catalog and checked against the
//! SHA-256 Nexo carries, kept in `<data>/ai` until the person deletes them, started on
//! loopback when the assistant needs it and stopped after ten minutes without use.
mod fetch;
mod install;
mod lifetime;
mod measure;
mod probe;
mod server;
mod unpack;

pub use probe::{Probe, SystemProbe};

use nexo_application::ports::{LocalDevice, LocalEndpoint, LocalStatus, NetworkPolicy};
use nexo_domain::{
    Error, Result,
    ai::local::{self, Backend, Device},
    hosts::AllowedHosts,
};
use serde_json::Value;
use server::Running;
use std::{
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

/// How long the server runs without being asked anything.
const IDLE: Duration = Duration::from_secs(600);

#[derive(Debug, Default, Clone)]
struct Progress {
    installing: bool,
    received: u64,
    total: u64,
    error: Option<String>,
}

struct Inner {
    root: PathBuf,
    probe: Arc<dyn Probe>,
    client: reqwest::Client,
    progress: Mutex<Progress>,
    running: tokio::sync::Mutex<Option<Running>>,
    hardware: tokio::sync::OnceCell<measure::Hardware>,
    measured: tokio::sync::Mutex<measure::Measured>,
}

/// The local model of this computer.
#[derive(Clone)]
pub struct LocalModels(Arc<Inner>);

/// What a marker file says.
fn read_json(path: &Path) -> Option<Value> {
    serde_json::from_str(&std::fs::read_to_string(path).ok()?).ok()
}

impl LocalModels {
    /// The local model kept in `root` (`<data>/ai`). Must be called inside a Tokio runtime.
    pub fn new(
        root: PathBuf,
        network: Arc<dyn NetworkPolicy>,
        probe: Arc<dyn Probe>,
    ) -> Result<Self> {
        let hosts = AllowedHosts::parse(&local::DOWNLOAD_HOSTS.map(String::from))?;
        Self::build(root, network, probe, hosts, "https")
    }
    fn build(
        root: PathBuf,
        network: Arc<dyn NetworkPolicy>,
        probe: Arc<dyn Probe>,
        hosts: AllowedHosts,
        scheme: &str,
    ) -> Result<Self> {
        let client = fetch::client(network, hosts, scheme)?;
        let models = Self(Arc::new(Inner {
            root,
            probe,
            client,
            progress: Mutex::default(),
            running: tokio::sync::Mutex::default(),
            hardware: tokio::sync::OnceCell::new(),
            measured: tokio::sync::Mutex::default(),
        }));
        models.watch_idle();
        Ok(models)
    }

    /// The engine installed: its backend and its `llama-server`.
    fn engine(&self) -> Option<(Backend, PathBuf)> {
        let marker = read_json(&self.0.root.join("engine").join("installed.json"))?;
        let backend = Backend::parse(marker["backend"].as_str()?)?;
        let folder = self.0.root.join("engine").join(marker["folder"].as_str()?);
        Some((backend, unpack::server_in(&folder)?))
    }

    /// The model installed: its id (`file` for the person's own), name and path.
    fn model(&self) -> Option<(String, String, PathBuf)> {
        let marker = read_json(&self.0.root.join("model.json"))?;
        if let Some(path) = marker["file"].as_str() {
            let path = PathBuf::from(path);
            let name = path.file_name()?.to_string_lossy().into_owned();
            return path.is_file().then_some(("file".into(), name, path));
        }
        let model = local::model(marker["id"].as_str()?).ok()?;
        let path = self.0.root.join("models").join(model_file(model));
        path.is_file()
            .then(|| (model.id.to_owned(), model.name.to_owned(), path))
    }

    /// Stops the server after ten minutes without being asked anything.
    fn watch_idle(&self) {
        let weak = Arc::downgrade(&self.0);
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(Duration::from_secs(60)).await;
                let Some(inner) = weak.upgrade() else { break };
                let mut running = inner.running.lock().await;
                if running
                    .as_ref()
                    .is_some_and(|server| server.last_used.elapsed() > IDLE)
                    && let Some(mut server) = running.take()
                {
                    let _ = server.child.kill().await;
                }
            }
        });
    }
}

/// The file name of a model of the catalog.
fn model_file(model: &local::Model) -> &'static str {
    model.url.rsplit('/').next().unwrap_or(model.id)
}

fn device(device: &Device) -> LocalDevice {
    LocalDevice {
        id: device.id.clone(),
        name: device.name.clone(),
        total_mib: device.total_mib,
        free_mib: device.free_mib,
    }
}

#[async_trait::async_trait]
impl nexo_application::ports::LocalModel for LocalModels {
    async fn status(&self) -> Result<LocalStatus> {
        self.status_now().await
    }
    async fn install(&self, model: Option<String>) -> Result<LocalStatus> {
        self.begin(model.as_deref()).await
    }
    async fn use_file(&self, path: String) -> Result<LocalStatus> {
        self.own_file(&path).await
    }
    async fn remove(&self) -> Result<LocalStatus> {
        if let Some(mut server) = self.0.running.lock().await.take() {
            let _ = server.child.kill().await;
        }
        for path in [self.0.root.join("engine"), self.0.root.join("models")] {
            let _ = std::fs::remove_dir_all(path);
        }
        let _ = std::fs::remove_file(self.0.root.join("model.json"));
        self.forget_devices().await;
        self.status_now().await
    }
    async fn endpoint(&self) -> Result<LocalEndpoint> {
        let mut running = self.0.running.lock().await;
        if let Some(server) = running.as_mut() {
            if server.child.try_wait().ok().flatten().is_none() {
                server.last_used = Instant::now();
                return Ok(LocalEndpoint {
                    url: format!("http://127.0.0.1:{}/v1", server.port),
                    port: server.port,
                    token: server.token.clone(),
                });
            }
            *running = None;
        }
        let (_, engine) = self.engine().ok_or_else(|| {
            Error::Validation("Download the local model in Settings → AI assistant".into())
        })?;
        let (_, _, model) = self.model().ok_or_else(|| {
            Error::Validation("Download the local model in Settings → AI assistant".into())
        })?;
        let (_, chosen) = self.devices(&engine).await;
        let server = server::start(&engine, &model, chosen.as_ref().map(|d| d.id.as_str())).await?;
        let endpoint = LocalEndpoint {
            url: format!("http://127.0.0.1:{}/v1", server.port),
            port: server.port,
            token: server.token.clone(),
        };
        *running = Some(server);
        Ok(endpoint)
    }
}

impl LocalModels {
    async fn status_now(&self) -> Result<LocalStatus> {
        let hardware = self.hardware().await;
        let platform = hardware.platform;
        let engine = self.engine();
        let backend = engine
            .as_ref()
            .map(|(backend, _)| *backend)
            .unwrap_or_else(|| local::backend(&platform, hardware.nvidia_driver, hardware.vulkan));
        let (devices, chosen) = match &engine {
            Some((_, server)) => self.devices(server).await,
            None => (Vec::new(), None),
        };
        let ram = self.0.probe.ram_free_mib();
        let plan = local::plan(chosen.as_ref().map_or(0, |d| d.free_mib), ram);
        let progress = self.0.progress.lock().unwrap().clone();
        let model = self.model();
        let running = self.0.running.lock().await;
        let log = running.as_ref().map(|server| server.log.lock().unwrap());
        let engine_size = local::engine(&platform, backend)
            .map(|assets| assets.iter().map(|asset| asset.size).sum())
            .unwrap_or(0);
        Ok(LocalStatus {
            backend: backend.as_str().into(),
            engine: engine.is_some(),
            model: model.as_ref().map(|(id, _, _)| id.clone()),
            model_name: model.as_ref().map(|(_, name, _)| name.clone()),
            engine_size,
            model_size: plan
                .as_ref()
                .map(|plan| plan.model.size)
                .unwrap_or(local::MODELS[1].size),
            recommended: plan.as_ref().ok().map(|plan| plan.model.id.to_owned()),
            reason: Some(match &plan {
                Ok(plan) => plan.reason.to_owned(),
                Err(error) => error.to_string(),
            }),
            devices: devices.iter().map(device).collect(),
            device: chosen.map(|d| d.id),
            ram_free_mib: ram,
            running: log.is_some(),
            gpu_layers: log.as_ref().and_then(|log| log.layers.clone()),
            context: log.as_ref().and_then(|log| log.context),
            installing: progress.installing,
            received: progress.received,
            total: progress.total,
            error: progress.error,
        })
    }
}

#[cfg(test)]
mod tests;
