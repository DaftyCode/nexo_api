//! Composition root shared by the desktop shell and the local web launcher.
use nexo_application::Application;
use nexo_domain::Result;
use nexo_engine::Engine;
use nexo_http::{AccessConfig, router};
pub use nexo_http::{Mode, Sessions};
use nexo_infrastructure::{
    clock::SystemClock, git::GitAdapter, infrastructure as err, native::NativeAdapter,
    sqlite::SqliteStore, task_files::LocalTaskFiles, user_files::HomeFiles,
    vault::desktop_master_key,
};
use nexo_modules::{HostConfig, Modules, StoreConfig};
use std::{
    path::{Path, PathBuf},
    sync::Arc,
};
use tokio::{sync::oneshot, task::JoinHandle};

pub mod config;
pub mod log_file;

#[derive(Clone, Debug)]
pub struct Config {
    pub data: PathBuf,
    pub mode: Mode,
    /// Per-run secret for the desktop shell, the development proxy and the launcher.
    pub token: String,
    pub origins: Vec<String>,
    /// Built web interface served in web mode.
    pub web_root: Option<PathBuf>,
    /// Overrides the master key kept in the operating system credential store.
    pub master_key: Option<String>,
}

pub fn random_token() -> String {
    format!(
        "{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    )
}

/// The directory the desktop app uses (`<data dir>/dev.nexo.api`), shared with web mode.
pub fn default_data_dir() -> PathBuf {
    directories::BaseDirs::new()
        .map(|dirs| dirs.data_dir().join("dev.nexo.api"))
        .unwrap_or_else(|| PathBuf::from(".nexo"))
}

/// Writes a file readable only by the current user where the platform allows it.
pub fn write_private(path: &Path, content: &str) -> Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(err)?;
    }
    std::fs::write(path, content).map_err(err)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600)).map_err(err)?;
    }
    Ok(())
}

/// The master key of the secret vault: explicit configuration, else the credential store.
/// Without a credential store (for example a headless Linux session) the engine keeps a
/// private key file in the data directory.
fn master_key(config: &Config) -> Option<String> {
    if let Some(key) = &config.master_key {
        return Some(key.clone());
    }
    match desktop_master_key() {
        Ok(key) => Some(key),
        Err(error) => {
            tracing::warn!(%error, "Credential store unavailable; using a key file in the data directory");
            None
        }
    }
}

/// Opens the execution engine over the data directory.
pub fn engine(config: &Config) -> Result<Arc<Engine>> {
    Ok(Arc::new(Engine::new(&config.data, master_key(config))?))
}

pub async fn application(config: &Config) -> Result<(Arc<Application>, Arc<Engine>)> {
    let store = Arc::new(SqliteStore::open(&config.data.join("nexo.sqlite"))?);
    let engine = engine(config)?;
    // Database drivers are downloaded modules, run in their own processes; their network
    // goes through the engine's egress policy.
    // A module that opens a file (SQLite) never opens one of Nexo's own data.
    let host = HostConfig {
        protected: vec![config.data.clone()],
        ..HostConfig::default()
    };
    let modules = Arc::new(Modules::new(
        StoreConfig::from_env(&config.data),
        host,
        engine.clone(),
    )?);
    // MongoDB is a module too (DB-39): the document database port goes to its driver, which
    // writes certificates in a temporary folder of its own. The folder the built-in adapter
    // used is no longer needed.
    let _ = std::fs::remove_dir_all(config.data.join("mongo-tls"));
    let application = Application::new(
        store,
        engine.clone(),
        engine.clone(),
        Arc::new(GitAdapter::new(
            config.data.join("projects"),
            engine.clone(),
        )),
        Arc::new(modules.documents()),
    );
    // A connection may read the user's pgpass file, only when it says so (DB-25).
    let mut application = application
        .with_modules(modules.clone())
        .with_datasources(modules)
        .with_user_files(Arc::new(HomeFiles));
    // The local client tools (`pg_dump`, `mysql`…) run programs of the computer with files
    // chosen in native dialogs: only the desktop app has them.
    if config.mode == Mode::Desktop {
        application = application
            .with_native_tools(Arc::new(NativeAdapter::new(
                engine.clone(),
                vec![config.data.clone()],
            )))
            // Saved tasks write and read files at the paths the person wrote (DB-40).
            .with_task_files(Arc::new(LocalTaskFiles::new(vec![config.data.clone()])));
    }
    let application = Arc::new(application);
    // Scripts reach the databases through the application, with its rules (`nx.mongo`).
    let databases: Arc<dyn nexo_application::ports::ScriptDatabase> = application.clone();
    engine.connect_databases(Arc::downgrade(&databases));
    Ok((application, engine))
}

/// A running service; `stop` drains connections and stops the engine.
pub struct Running {
    pub port: u16,
    pub sessions: Arc<Sessions>,
    shutdown: Option<oneshot::Sender<()>>,
    task: JoinHandle<()>,
    /// The monitors' scheduler, which runs while the service does.
    monitors: JoinHandle<()>,
    engine: Arc<Engine>,
}
impl Running {
    pub async fn stop(mut self) {
        if let Some(shutdown) = self.shutdown.take() {
            let _ = shutdown.send(());
        }
        self.monitors.abort();
        let _ = tokio::time::timeout(std::time::Duration::from_secs(10), &mut self.task).await;
        self.engine.close();
    }
}

/// Starts the service on a loopback address; it never listens on other interfaces.
pub async fn serve(config: Config, address: &str) -> Result<Running> {
    let socket: std::net::SocketAddr = address.parse().map_err(err)?;
    if !socket.ip().is_loopback() {
        return Err(err(
            "Nexo only listens on this computer; use a loopback address such as 127.0.0.1",
        ));
    }
    let listener = tokio::net::TcpListener::bind(socket)
        .await
        .map_err(|error| {
            err(format!(
                "Cannot listen on {socket}: {error}. Is another program using the port?"
            ))
        })?;
    let (app, engine) = application(&config).await?;
    let port = listener.local_addr().map_err(err)?.port();
    let mut origins = config.origins.clone();
    if config.mode == Mode::Web {
        origins.extend([
            format!("http://127.0.0.1:{port}"),
            format!("http://localhost:{port}"),
        ]);
    }
    let access = AccessConfig {
        mode: config.mode,
        token: config.token.clone(),
        allowed_origins: origins,
        web_root: config.web_root.clone(),
    };
    let sessions = Arc::new(Sessions::default());
    // Monitors run on their schedules only while Nexo is open: no service outlives it.
    let monitors = tokio::spawn(app.clone().run_monitors(Arc::new(SystemClock)));
    let routes = router(app, access, sessions.clone());
    let (shutdown, signal) = oneshot::channel::<()>();
    let task = tokio::spawn(async move {
        let server = axum::serve(listener, routes).with_graceful_shutdown(async {
            let _ = signal.await;
        });
        if let Err(error) = server.await {
            tracing::error!(%error, "HTTP service stopped");
        }
    });
    Ok(Running {
        port,
        sessions,
        shutdown: Some(shutdown),
        task,
        monitors,
        engine,
    })
}
