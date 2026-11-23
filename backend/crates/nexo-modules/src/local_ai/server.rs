//! `llama-server` as Nexo runs it: on loopback, with a key made for each start and passed in
//! its environment (never on its command line), without its own web interface nor its tools,
//! one conversation at a time, a bounded cache of prompts, and `--fit` setting the layers on
//! the GPU and the context to the memory free when it loads. What it chose is read from its
//! log, which says it from verbosity 4 without writing what is asked.
use super::lifetime;
use nexo_domain::{Error, Result, ai::local::FIT_MARGIN_MIB};
use std::{
    collections::VecDeque,
    ffi::OsString,
    path::Path,
    process::Stdio,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tokio::{
    io::{AsyncBufReadExt, BufReader},
    process::{Child, Command},
};

/// Lines of the log kept to explain a failed start.
const LOG_LINES: usize = 40;
/// Characters kept of each line.
const LINE_CHARS: usize = 1000;
/// How long a model may take to load from the disk.
const LOADING: Duration = Duration::from_secs(300);
/// What the server needs from the environment; nothing of the person's configuration.
const ENVIRONMENT: &[&str] = &["SystemRoot", "windir", "TEMP", "TMP", "TMPDIR", "HOME"];

/// What the log said.
#[derive(Debug, Default)]
pub(crate) struct Log {
    pub lines: VecDeque<String>,
    /// `33/33`: the layers on the GPU.
    pub layers: Option<String>,
    pub context: Option<u64>,
}

impl Log {
    pub(crate) fn read(&mut self, line: &str) {
        if let Some(at) = line.find("offloaded ")
            && let Some(layers) = line[at + 10..].split_whitespace().next()
            && line.contains("layers to GPU")
        {
            self.layers = Some(layers.to_owned());
        }
        if let Some((name, value)) = line.split_once('=')
            && name.split_whitespace().last() == Some("n_ctx")
            && let Ok(context) = value.split_whitespace().next().unwrap_or("").parse()
        {
            self.context = Some(context);
        }
        if self.lines.len() == LOG_LINES {
            self.lines.pop_front();
        }
        self.lines
            .push_back(line.chars().take(LINE_CHARS).collect());
    }
    fn tail(&self) -> String {
        let lines: Vec<&str> = self
            .lines
            .iter()
            .rev()
            .take(6)
            .map(String::as_str)
            .collect();
        lines.into_iter().rev().collect::<Vec<_>>().join("\n")
    }
}

/// The arguments of a start.
pub(crate) fn arguments(model: &Path, port: u16, device: Option<&str>) -> Vec<OsString> {
    let mut found: Vec<OsString> = vec![
        "--model".into(),
        model.into(),
        "--host".into(),
        "127.0.0.1".into(),
        "--port".into(),
        port.to_string().into(),
        "--no-webui".into(),
        // Its own tools (files, shell) and proxy stay off whatever its defaults become.
        "--no-agent".into(),
        "--parallel".into(),
        "1".into(),
        "--fit".into(),
        "on".into(),
        "--fit-target".into(),
        FIT_MARGIN_MIB.to_string().into(),
        "--fit-ctx".into(),
        "8192".into(),
        // Prompts kept in memory to continue a conversation: 1 GiB, not its 8.
        "--cache-ram".into(),
        "1024".into(),
        "--ctx-checkpoints".into(),
        "8".into(),
        // The layers on the GPU and the context are written from this level.
        "--log-verbosity".into(),
        "4".into(),
    ];
    if let Some(device) = device {
        found.extend(["--device".into(), device.into()]);
    }
    found
}

/// The command of the engine at `server`, with nothing of the person's environment but what
/// it needs, its libraries found next to it, and no console window.
pub(crate) fn command(server: &Path) -> Command {
    let mut command = Command::new(server);
    command.env_clear().envs(
        ENVIRONMENT
            .iter()
            .filter_map(|name| Some((name, std::env::var_os(name)?))),
    );
    if let Some(folder) = server.parent()
        && !cfg!(windows)
    {
        command.env("LD_LIBRARY_PATH", folder);
    }
    command.stdin(Stdio::null()).kill_on_drop(true);
    #[cfg(windows)]
    command.creation_flags(0x08000000);
    command
}

/// The devices the engine sees (`--list-devices`), as it writes them.
pub(crate) async fn list_devices(server: &Path) -> String {
    let mut command = command(server);
    command
        .arg("--list-devices")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    match tokio::time::timeout(Duration::from_secs(60), command.output()).await {
        Ok(Ok(output)) => format!(
            "{}\n{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        ),
        _ => String::new(),
    }
}

/// Reads the engine's output to its end, a line at a time. Bytes that are not UTF-8 (a token
/// cut in two) are replaced, and reading never stops while the engine writes: a full pipe
/// would halt it in the middle of an answer.
pub(crate) async fn drain(stream: impl tokio::io::AsyncRead + Unpin, log: Arc<Mutex<Log>>) {
    let mut reader = BufReader::new(stream);
    let mut line = Vec::new();
    loop {
        line.clear();
        match reader.read_until(b'\n', &mut line).await {
            Ok(0) | Err(_) => break,
            Ok(_) => log
                .lock()
                .unwrap()
                .read(String::from_utf8_lossy(&line).trim_end()),
        }
    }
}

/// A server that runs.
pub(crate) struct Running {
    pub child: Child,
    pub port: u16,
    pub token: String,
    pub last_used: Instant,
    pub log: Arc<Mutex<Log>>,
}

/// A port of loopback nobody listens on now.
fn free_port() -> Result<u16> {
    let listener = std::net::TcpListener::bind("127.0.0.1:0")
        .map_err(|error| Error::Infrastructure(error.to_string()))?;
    Ok(listener
        .local_addr()
        .map_err(|error| Error::Infrastructure(error.to_string()))?
        .port())
}

/// A key for one start: 32 random bytes in hexadecimal.
fn token() -> String {
    let mut bytes = [0u8; 32];
    let _ = aws_lc_rs::rand::fill(&mut bytes);
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

/// Starts the engine at `server` with `model` and waits until it answers.
pub(crate) async fn start(server: &Path, model: &Path, device: Option<&str>) -> Result<Running> {
    let port = free_port()?;
    let token = token();
    let mut command = command(server);
    command
        .args(arguments(model, port, device))
        .env("LLAMA_API_KEY", &token)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    lifetime::before_start(&mut command);
    let mut child = command.spawn().map_err(|error| {
        Error::Unavailable(format!("The local model could not be started: {error}"))
    })?;
    lifetime::after_start(&child);
    let log = Arc::new(Mutex::new(Log::default()));
    for stream in [
        child
            .stdout
            .take()
            .map(|out| Box::new(out) as Box<dyn tokio::io::AsyncRead + Unpin + Send>),
        child
            .stderr
            .take()
            .map(|err| Box::new(err) as Box<dyn tokio::io::AsyncRead + Unpin + Send>),
    ]
    .into_iter()
    .flatten()
    {
        tokio::spawn(drain(stream, log.clone()));
    }
    let health = format!("http://127.0.0.1:{port}/health");
    let client = reqwest::Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(5))
        .build()
        .map_err(|error| Error::Infrastructure(error.to_string()))?;
    let started = Instant::now();
    loop {
        if let Ok(Some(status)) = child.try_wait() {
            let tail = log.lock().unwrap().tail();
            return Err(Error::Unavailable(format!(
                "The local model stopped while it loaded ({status}): {tail}"
            )));
        }
        if let Ok(answer) = client.get(&health).send().await
            && answer.status().is_success()
        {
            break;
        }
        if started.elapsed() > LOADING {
            let _ = child.kill().await;
            return Err(Error::Unavailable(
                "The local model took too long to load".into(),
            ));
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
    Ok(Running {
        child,
        port,
        token,
        last_used: Instant::now(),
        log,
    })
}
