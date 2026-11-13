//! Use cases depend only on domain types and outbound ports.
mod database;
mod execute;
pub mod mcp;
mod modules;
pub mod operations;
pub mod payloads;
pub mod ports;
#[cfg(test)]
mod testing;
#[cfg(test)]
mod tests;
mod vault;
mod workspaces;

use ports::{
    DocumentDatabase, ExecutionGateway, ModuleCatalog, SecretVault, VersionControl,
    WorkspaceRepository,
};
use std::sync::Arc;

pub use vault::vault_references;

/// History entries kept per workspace; older ones are deleted when a new one is saved.
pub const HISTORY_LIMIT: usize = 200;
/// MongoDB queries kept in a workspace's query history.
pub const QUERY_HISTORY_LIMIT: usize = 100;

pub struct Application {
    workspaces: Arc<dyn WorkspaceRepository>,
    executor: Arc<dyn ExecutionGateway>,
    secrets: Arc<dyn SecretVault>,
    git: Arc<dyn VersionControl>,
    database: Arc<dyn DocumentDatabase>,
    /// The downloadable database drivers; `None` where the composition root has none.
    modules: Option<Arc<dyn ModuleCatalog>>,
}
impl Application {
    pub fn new(
        workspaces: Arc<dyn WorkspaceRepository>,
        executor: Arc<dyn ExecutionGateway>,
        secrets: Arc<dyn SecretVault>,
        git: Arc<dyn VersionControl>,
        database: Arc<dyn DocumentDatabase>,
    ) -> Self {
        Self {
            workspaces,
            executor,
            secrets,
            git,
            database,
            modules: None,
        }
    }
    /// Adds the database modules.
    pub fn with_modules(mut self, modules: Arc<dyn ModuleCatalog>) -> Self {
        self.modules = Some(modules);
        self
    }
}
