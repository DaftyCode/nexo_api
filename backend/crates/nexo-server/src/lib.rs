//! Composition root shared by desktop and server binaries.
use nexo_application::Application;
use nexo_domain::Result;
use nexo_http::{AccessConfig, router};
use nexo_infrastructure::{
    executor::NodeExecutor,
    git::GitAdapter,
    infrastructure as err,
    sqlite::SqliteStore,
    vault::{VaultAdapter, desktop_master_key},
};
use std::{path::PathBuf, sync::Arc};
pub struct Config {
    pub data: PathBuf,
    pub node: PathBuf,
    pub engine: PathBuf,
    pub mode: String,
    pub token: Option<String>,
    pub allow_signup: bool,
    pub origins: Vec<String>,
}
pub async fn application(config: &Config) -> Result<Arc<Application>> {
    let store = Arc::new(SqliteStore::open(&config.data.join("nexo.sqlite"))?);
    let master = if config.mode == "desktop" {
        Some(desktop_master_key()?)
    } else {
        std::env::var("NEXO_MASTER_KEY").ok()
    };
    let executor = Arc::new(
        NodeExecutor::spawn(
            config.node.clone(),
            config.engine.clone(),
            config.data.clone(),
            master,
        )
        .await?,
    );
    Ok(Arc::new(Application::new(
        store.clone(),
        store,
        executor.clone(),
        Arc::new(VaultAdapter::new(executor)),
        Arc::new(GitAdapter::new(config.data.join("projects"))),
    )))
}
pub async fn serve(config: Config, address: &str) -> Result<u16> {
    let socket: std::net::SocketAddr = address.parse().map_err(err)?;
    if config.mode != "server" && !socket.ip().is_loopback() {
        return Err(err(
            "Local mode must bind to a loopback address; select server mode for remote access",
        ));
    }
    let app = application(&config).await?;
    let listener = tokio::net::TcpListener::bind(socket).await.map_err(err)?;
    let port = listener.local_addr().map_err(err)?.port();
    let access = AccessConfig {
        mode: config.mode,
        desktop_token: config.token,
        allow_signup: config.allow_signup,
        allowed_origins: config.origins,
    };
    tokio::spawn(async move {
        if let Err(error) = axum::serve(listener, router(app, access)).await {
            tracing::error!(%error,"HTTP service stopped");
        }
    });
    Ok(port)
}
