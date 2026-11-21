//! Use cases depend only on domain types and outbound ports.
mod database;
mod datasource;
mod environments;
mod execute;
mod masking;
pub mod mcp;
mod modules;
mod monitors;
mod native;
pub mod operations;
pub mod payloads;
pub mod ports;
mod ssh;
#[cfg(test)]
mod testing;
#[cfg(test)]
mod tests;
mod vault;
mod workspaces;

use ports::{
    DataSources, DocumentDatabase, ExecutionGateway, ModuleCatalog, NativeTools, SecretVault,
    UserFiles, VersionControl, WorkspaceRepository,
};
use std::sync::Arc;

pub use monitors::MONITOR_HISTORY_LIMIT;
pub use vault::vault_references;

/// History entries kept per workspace; older ones are deleted when a new one is saved.
pub const HISTORY_LIMIT: usize = 200;
/// Room for a workspace's request history, responses included: the oldest entries go first.
pub const HISTORY_BYTES: usize = 20 * 1024 * 1024;
/// Finished collection runs kept per workspace, and the room they have together.
pub const RUN_LIMIT: usize = 20;
pub const RUN_BYTES: usize = 20 * 1024 * 1024;
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
    /// The local client tools of the databases; only the desktop app has them.
    native: Option<Arc<dyn NativeTools>>,
    /// The user's own files a connection may read (pgpass).
    user_files: Option<Arc<dyn UserFiles>>,
    /// What the monitors are doing now.
    monitors: monitors::Board,
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
            native: None,
            user_files: None,
            monitors: monitors::Board::default(),
        }
    }
    /// Adds the databases of the modules.
    pub fn with_datasources(mut self, datasources: Arc<dyn DataSources>) -> Self {
        self.datasources = Some(datasources);
        self
    }
    /// Adds the local client tools of the databases (the desktop app).
    pub fn with_native_tools(mut self, native: Arc<dyn NativeTools>) -> Self {
        self.native = Some(native);
        self
    }
    /// Adds the user's own files a connection may read (pgpass).
    pub fn with_user_files(mut self, files: Arc<dyn UserFiles>) -> Self {
        self.user_files = Some(files);
        self
    }
    /// Adds the database modules.
    pub fn with_modules(mut self, modules: Arc<dyn ModuleCatalog>) -> Self {
        self.modules = Some(modules);
        self
    }
}
