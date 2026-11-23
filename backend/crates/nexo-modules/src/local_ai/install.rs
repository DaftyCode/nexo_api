//! Installing the local model in the background: the engine for the computer's GPU (the
//! Vulkan build when the CUDA one sees no CUDA device, as with an NVIDIA driver too old for
//! it), then the model that fits the free memory, or a GGUF of the person's own. One model at
//! a time: another one replaces it.
use super::{LocalModels, Progress, fetch, model_file, server, unpack};
use nexo_application::ports::LocalStatus;
use nexo_domain::{
    Error, Result,
    ai::local::{self, Backend},
};
use serde_json::json;
use std::path::{Path, PathBuf};

fn io(error: std::io::Error) -> Error {
    Error::Infrastructure(error.to_string())
}

/// Deletes what `folder` holds but `keep`.
fn keep_only(folder: &Path, keep: &[&str]) {
    for entry in std::fs::read_dir(folder).into_iter().flatten().flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if !keep.contains(&name.as_str()) {
            let path = entry.path();
            let _ = if path.is_dir() {
                std::fs::remove_dir_all(path)
            } else {
                std::fs::remove_file(path)
            };
        }
    }
}

impl LocalModels {
    fn total(&self, total: u64) {
        let mut progress = self.0.progress.lock().unwrap();
        (progress.total, progress.received) = (total, 0);
    }
    fn received(&self, received: u64) {
        self.0.progress.lock().unwrap().received = received;
    }

    /// Starts installing in the background: the engine, then `wanted` or the model that fits.
    pub(super) async fn begin(&self, wanted: Option<&str>) -> Result<LocalStatus> {
        let wanted = wanted.map(local::model).transpose()?.map(|model| model.id);
        self.spawn(wanted, true);
        self.status_now().await
    }

    fn spawn(&self, wanted: Option<&'static str>, model: bool) {
        {
            let mut progress = self.0.progress.lock().unwrap();
            if progress.installing {
                return;
            }
            *progress = Progress {
                installing: true,
                ..Progress::default()
            };
        }
        let this = self.clone();
        tokio::spawn(async move {
            let outcome = this.run(wanted, model).await;
            let mut progress = this.0.progress.lock().unwrap();
            progress.installing = false;
            progress.error = outcome.err().map(|error| error.to_string());
        });
    }

    async fn run(&self, wanted: Option<&str>, with_model: bool) -> Result<()> {
        let (_, server) = match self.engine() {
            Some(found) => found,
            None => self.install_engine().await?,
        };
        if !with_model {
            return Ok(());
        }
        let model = match wanted {
            Some(id) => local::model(id)?,
            None => {
                let (_, chosen) = self.devices(&server).await;
                let free = chosen.map_or(0, |device| device.free_mib);
                local::plan(free, self.0.probe.ram_free_mib())?.model
            }
        };
        let folder = self.0.root.join("models");
        std::fs::create_dir_all(&folder).map_err(io)?;
        let file = model_file(model);
        let part = format!("{}.part", file.trim_end_matches(".gguf"));
        keep_only(&folder, &[file, &part]);
        let target = folder.join(file);
        if !target.is_file() {
            self.total(model.size);
            fetch::fetch(
                &self.0.client,
                model.url,
                &target,
                model.size,
                model.sha256,
                |n| self.received(n),
            )
            .await?;
        }
        self.choose(json!({"id": model.id})).await
    }

    /// Records the model to run and stops a server that runs another one.
    async fn choose(&self, marker: serde_json::Value) -> Result<()> {
        std::fs::create_dir_all(&self.0.root).map_err(io)?;
        std::fs::write(self.0.root.join("model.json"), marker.to_string()).map_err(io)?;
        if let Some(mut server) = self.0.running.lock().await.take() {
            let _ = server.child.kill().await;
        }
        Ok(())
    }

    async fn install_engine(&self) -> Result<(Backend, PathBuf)> {
        let hardware = self.hardware().await;
        let platform = hardware.platform;
        let mut backend = local::backend(&platform, hardware.nvidia_driver, hardware.vulkan);
        let engines = self.0.root.join("engine");
        let downloads = self.0.root.join("downloads");
        std::fs::create_dir_all(&downloads).map_err(io)?;
        loop {
            let assets = local::engine(&platform, backend).ok_or_else(|| {
                Error::Unavailable(format!("Nexo has no local model for {platform}"))
            })?;
            let name = format!("{}-{}", local::ENGINE_BUILD, backend.as_str());
            let folder = engines.join(&name);
            let _ = std::fs::remove_dir_all(&folder);
            self.total(assets.iter().map(|asset| asset.size).sum());
            let mut done = 0;
            for asset in assets {
                let file = downloads.join(asset.url.rsplit('/').next().unwrap_or("engine"));
                fetch::fetch(
                    &self.0.client,
                    asset.url,
                    &file,
                    asset.size,
                    asset.sha256,
                    |n| self.received(done + n),
                )
                .await?;
                done += asset.size;
                let (archive, into) = (file.clone(), folder.clone());
                tokio::task::spawn_blocking(move || unpack::unpack(&archive, &into))
                    .await
                    .map_err(|error| Error::Infrastructure(error.to_string()))??;
                let _ = std::fs::remove_file(&file);
            }
            let server = unpack::server_in(&folder).ok_or_else(|| {
                Error::Infrastructure("The engine of the local model has no llama-server".into())
            })?;
            if backend == Backend::Cuda && hardware.vulkan {
                let devices = local::devices(&server::list_devices(&server).await);
                if !devices.iter().any(|device| device.id.starts_with("CUDA")) {
                    let _ = std::fs::remove_dir_all(&folder);
                    backend = Backend::Vulkan;
                    continue;
                }
            }
            std::fs::write(
                engines.join("installed.json"),
                json!({"backend": backend.as_str(), "folder": name}).to_string(),
            )
            .map_err(io)?;
            keep_only(&engines, &[name.as_str(), "installed.json"]);
            self.forget_devices().await;
            return Ok((backend, server));
        }
    }

    /// Uses a GGUF of the person's own: the downloaded model is deleted, and the engine is
    /// downloaded when it is not there yet.
    pub(super) async fn own_file(&self, path: &str) -> Result<LocalStatus> {
        let path = PathBuf::from(path.trim());
        let gguf = path
            .extension()
            .is_some_and(|extension| extension.eq_ignore_ascii_case("gguf"));
        let mut magic = [0u8; 4];
        let readable = std::fs::File::open(&path)
            .and_then(|mut file| std::io::Read::read_exact(&mut file, &mut magic))
            .is_ok();
        if !gguf || !readable || &magic != b"GGUF" {
            return Err(Error::Validation(format!(
                "{} is not a GGUF model file",
                path.display()
            )));
        }
        self.choose(json!({"file": path})).await?;
        let _ = std::fs::remove_dir_all(self.0.root.join("models"));
        if self.engine().is_none() {
            self.spawn(None, false);
        }
        self.status_now().await
    }
}
