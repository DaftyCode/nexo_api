//! The database modules: drivers that are downloaded when they are first needed, installed
//! after their hash is checked, and removed when they are not wanted.
use async_trait::async_trait;
use nexo_domain::Result;
use serde::Serialize;

/// Where a module stands on this computer.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ModuleState {
    /// Can be downloaded.
    Available,
    Installed,
    /// A version for an older Nexo is installed: it is downloaded again before it is used.
    Outdated,
    /// A driver built from the sources, used as it is (development builds only).
    Development,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModuleSummary {
    /// `postgres`, `mssql`…
    pub id: String,
    pub name: String,
    pub description: String,
    pub version: String,
    pub state: ModuleState,
    /// Bytes downloaded to install it.
    pub download_size: u64,
    /// Bytes it takes once installed.
    pub size: u64,
    /// The licenses of the code it contains.
    pub licenses: Vec<String>,
    /// The address it is downloaded from.
    pub source: String,
    /// A copy came with Nexo (the portable package): installing it needs no network.
    pub bundled: bool,
}

/// What an installation is doing.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum InstallState {
    /// Nothing has been asked since Nexo started.
    Idle,
    Downloading,
    /// Checking the hashes and writing the driver.
    Verifying,
    Installed,
    Failed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallProgress {
    pub id: String,
    pub state: InstallState,
    /// Bytes downloaded so far, of `total`.
    pub received: u64,
    pub total: u64,
    /// Why it failed.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}
impl InstallProgress {
    pub fn idle(id: &str) -> Self {
        Self {
            id: id.to_owned(),
            state: InstallState::Idle,
            received: 0,
            total: 0,
            error: None,
        }
    }
}

#[async_trait]
pub trait ModuleCatalog: Send + Sync {
    /// The modules of this version of Nexo, with their state on this computer.
    async fn modules(&self) -> Result<Vec<ModuleSummary>>;
    /// Starts installing a module and answers at once; [`ModuleCatalog::progress`] follows
    /// it. Asking again while it installs answers the same progress.
    async fn install(&self, id: &str) -> Result<InstallProgress>;
    async fn progress(&self, id: &str) -> Result<InstallProgress>;
    /// Installs a module from a file the person chose, recognised by its hash: the file
    /// downloaded from the releases, or the driver itself.
    async fn install_file(&self, content: Vec<u8>) -> Result<ModuleSummary>;
    /// Stops the module's driver and deletes it. Saved connections stay.
    async fn remove(&self, id: &str) -> Result<()>;
}
