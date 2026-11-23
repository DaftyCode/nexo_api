//! What the computer has, measured without holding up Nexo. The platform, the NVIDIA driver
//! and Vulkan do not change while Nexo runs: they are read once, away from the threads that
//! answer requests (`nvidia-smi` takes seconds). The GPUs and their free memory come from
//! `llama-server --list-devices`, a process too: the calls that arrive together share one
//! measurement, and none is taken while a download runs.
use super::{LocalModels, server};
use nexo_domain::ai::local::{self, Device};
use std::{
    path::Path,
    time::{Duration, Instant},
};

/// How long a measurement of the GPUs serves the calls that come with it.
const SHARED: Duration = Duration::from_secs(2);

/// What does not change while Nexo runs.
#[derive(Debug, Clone)]
pub(super) struct Hardware {
    pub platform: String,
    pub nvidia_driver: Option<u32>,
    pub vulkan: bool,
}

/// The last measurement of the GPUs, when it was taken.
pub(super) type Measured = Option<(Instant, Vec<Device>)>;

impl LocalModels {
    pub(super) async fn hardware(&self) -> Hardware {
        self.0
            .hardware
            .get_or_init(|| async {
                let probe = self.0.probe.clone();
                let platform = probe.platform();
                let fallback = Hardware {
                    platform: platform.clone(),
                    nvidia_driver: None,
                    vulkan: false,
                };
                tokio::task::spawn_blocking(move || Hardware {
                    platform,
                    nvidia_driver: probe.nvidia_driver(),
                    vulkan: probe.vulkan(),
                })
                .await
                .unwrap_or(fallback)
            })
            .await
            .clone()
    }

    /// The devices the engine at `server` sees, and the one it runs on.
    pub(super) async fn devices(&self, server: &Path) -> (Vec<Device>, Option<Device>) {
        let installing = self.0.progress.lock().unwrap().installing;
        let mut measured = self.0.measured.lock().await;
        let recent = measured
            .as_ref()
            .is_some_and(|(at, _)| installing || at.elapsed() < SHARED);
        if !recent {
            let devices = local::devices(&server::list_devices(server).await);
            *measured = Some((Instant::now(), devices));
        }
        let devices = measured
            .as_ref()
            .map(|(_, devices)| devices.clone())
            .unwrap_or_default();
        let chosen = local::device(&devices).cloned();
        (devices, chosen)
    }

    /// The engine changed: its devices are measured again.
    pub(super) async fn forget_devices(&self) {
        *self.0.measured.lock().await = None;
    }
}
