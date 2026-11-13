//! The modules as the application sees them: listed, installed in the background with their
//! progress, installed from a file, and removed.
use crate::{
    download::{client, download},
    host::{DriverHost, HostConfig},
    store::{ModuleStore, StoreConfig, unpack},
};
use async_trait::async_trait;
use nexo_application::ports::{
    InstallProgress, InstallState, ModuleCatalog, ModuleSummary, NetworkPolicy,
};
use nexo_domain::{Error, Result};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};

type Installs = Arc<Mutex<HashMap<String, InstallProgress>>>;

/// The modules and the host that runs their drivers.
pub struct Modules {
    store: Arc<ModuleStore>,
    host: DriverHost,
    client: reqwest::Client,
    installs: Installs,
}

fn blocking_failed(error: tokio::task::JoinError) -> Error {
    Error::Infrastructure(error.to_string())
}

impl Modules {
    /// The modules of `store`, run by a host made with `config` (its executables come from
    /// the store). Must be called inside a Tokio runtime.
    pub fn new(
        store: StoreConfig,
        mut config: HostConfig,
        network: Arc<dyn NetworkPolicy>,
    ) -> Result<Self> {
        let scheme = store.source.scheme().to_owned();
        let store = Arc::new(ModuleStore::new(store));
        let client = client(network.clone(), store.hosts().clone(), scheme)?;
        config.executables = store.clone();
        Ok(Self {
            host: DriverHost::new(config, network),
            store,
            client,
            installs: Installs::default(),
        })
    }
    /// The host of the drivers, for the operations on connections.
    pub fn host(&self) -> &DriverHost {
        &self.host
    }

    fn set(installs: &Installs, progress: InstallProgress) {
        installs
            .lock()
            .unwrap()
            .insert(progress.id.clone(), progress);
    }

    /// Downloads (or reads the bundled copy), checks and installs a module.
    async fn run_install(
        store: Arc<ModuleStore>,
        host: DriverHost,
        client: reqwest::Client,
        installs: Installs,
        id: String,
    ) -> Result<()> {
        let entry = store.entry(&id)?.clone();
        let progress = |state, received| InstallProgress {
            id: id.clone(),
            state,
            received,
            total: entry.compressed_size,
            error: None,
        };
        let compressed = match store.bundled(&entry) {
            Some(path) => tokio::fs::read(&path)
                .await
                .map_err(|error| Error::Infrastructure(format!("{}: {error}", path.display())))?,
            None => {
                let url = store.url(&entry)?;
                download(&client, url, &entry, |received| {
                    Self::set(&installs, progress(InstallState::Downloading, received));
                })
                .await?
            }
        };
        Self::set(
            &installs,
            progress(InstallState::Verifying, entry.compressed_size),
        );
        let checked = entry.clone();
        let driver = tokio::task::spawn_blocking(move || match unpack(&checked, &compressed) {
            Ok(driver) => Ok(driver),
            // A bundled copy may be the driver itself rather than the release asset.
            Err(_) if crate::store::sha256(&compressed) == checked.sha256 => Ok(compressed),
            Err(error) => Err(error),
        })
        .await
        .map_err(blocking_failed)??;
        // A running driver cannot be replaced; its connections close.
        host.stop(&id).await;
        tokio::task::spawn_blocking(move || store.commit(&entry, &driver))
            .await
            .map_err(blocking_failed)?
    }
}

#[async_trait]
impl ModuleCatalog for Modules {
    async fn modules(&self) -> Result<Vec<ModuleSummary>> {
        let store = self.store.clone();
        tokio::task::spawn_blocking(move || store.summaries())
            .await
            .map_err(blocking_failed)
    }

    async fn install(&self, id: &str) -> Result<InstallProgress> {
        let entry = self.store.entry(id)?;
        {
            let mut installs = self.installs.lock().unwrap();
            if let Some(running) = installs.get(id).filter(|progress| {
                matches!(
                    progress.state,
                    InstallState::Downloading | InstallState::Verifying
                )
            }) {
                return Ok(running.clone());
            }
            let started = InstallProgress {
                id: id.to_owned(),
                state: InstallState::Downloading,
                received: 0,
                total: entry.compressed_size,
                error: None,
            };
            installs.insert(id.to_owned(), started);
        }
        let (store, host, client, installs) = (
            self.store.clone(),
            self.host.clone(),
            self.client.clone(),
            self.installs.clone(),
        );
        let id = id.to_owned();
        let started = self.progress(&id).await?;
        tokio::spawn(async move {
            let outcome =
                Self::run_install(store.clone(), host, client, installs.clone(), id.clone()).await;
            let total = store
                .entry(&id)
                .map(|entry| entry.compressed_size)
                .unwrap_or_default();
            let (state, error) = match outcome {
                Ok(()) => (InstallState::Installed, None),
                Err(error) => {
                    tracing::warn!(target: "nexo::modules", module = %id, %error, "A module was not installed");
                    (InstallState::Failed, Some(error.to_string()))
                }
            };
            let received = if state == InstallState::Installed {
                total
            } else {
                0
            };
            Self::set(
                &installs,
                InstallProgress {
                    id,
                    state,
                    received,
                    total,
                    error,
                },
            );
        });
        Ok(started)
    }

    async fn progress(&self, id: &str) -> Result<InstallProgress> {
        let installs = self.installs.lock().unwrap();
        Ok(installs
            .get(id)
            .cloned()
            .unwrap_or_else(|| InstallProgress::idle(id)))
    }

    async fn install_file(&self, content: Vec<u8>) -> Result<ModuleSummary> {
        let store = self.store.clone();
        let (entry, driver) = tokio::task::spawn_blocking(move || {
            store
                .recognise(&content)
                .map(|(entry, driver)| (entry.clone(), driver))
        })
        .await
        .map_err(blocking_failed)??;
        self.host.stop(&entry.id).await;
        let store = self.store.clone();
        tokio::task::spawn_blocking(move || {
            store
                .commit(&entry, &driver)
                .map(|()| store.summary(&entry))
        })
        .await
        .map_err(blocking_failed)?
    }

    async fn remove(&self, id: &str) -> Result<()> {
        if !crate::catalog::valid_id(id) {
            return Err(Error::Validation("Invalid module name".into()));
        }
        if self.store.is_development(id) {
            return Err(Error::Validation(
                "A module built from the sources is not removed from Nexo".into(),
            ));
        }
        self.host.stop(id).await;
        let store = self.store.clone();
        let id = id.to_owned();
        let removed = id.clone();
        tokio::task::spawn_blocking(move || store.remove_files(&id))
            .await
            .map_err(blocking_failed)??;
        self.installs.lock().unwrap().remove(&removed);
        Ok(())
    }
}
