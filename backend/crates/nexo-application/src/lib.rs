//! Use cases depend only on domain types and outbound ports.
mod database;
mod datasource;
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
    DataSources, DocumentDatabase, ExecutionGateway, ModuleCatalog, SecretVault, VersionControl,
    WorkspaceRepository,
};
use std::sync::Arc;

pub use vault::vault_references;

/// History entries kept per workspace; older ones are deleted when a new one is saved.
pub const HISTORY_LIMIT: usize = 200;
/// MongoDB queries kept in a workspace's query history.
pub const QUERY_HISTORY_LIMIT: usize = 100;
/// Statements kept in a workspace's SQL history.
pub const SQL_HISTORY_LIMIT: usize = 500;

pub struct Application {
    workspaces: Arc<dyn WorkspaceRepository>,
    executor: Arc<dyn ExecutionGateway>,
    secrets: Arc<dyn SecretVault>,
    git: Arc<dyn VersionControl>,
    database: Arc<dyn DocumentDatabase>,
    /// The downloadable database drivers; `None` where the composition root has none.
    modules: Option<Arc<dyn ModuleCatalog>>,
    /// The databases of the modules; `None` where the composition root has none.
    datasources: Option<Arc<dyn DataSources>>,
    /// The sessions open on them.
    sql_sessions: datasource::Sessions,
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
            datasources: None,
            sql_sessions: datasource::Sessions::default(),
        }
    }
    /// Adds the databases of the modules.
    pub fn with_datasources(mut self, datasources: Arc<dyn DataSources>) -> Self {
        self.datasources = Some(datasources);
        self
    }
    /// Adds the database modules.
    pub fn with_modules(mut self, modules: Arc<dyn ModuleCatalog>) -> Self {
        self.modules = Some(modules);
        self
    }
}
