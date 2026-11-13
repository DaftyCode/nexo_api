//! One driver process: started without arguments and with an almost empty environment,
//! spoken to over its standard input and output, and stopped with Nexo.
use crate::{host::LogSink, redact::Secrets, resolve::Answers};
use nexo_driver_sdk::{
    Client, DriverError, PROTOCOL_VERSION, Peer, Result, protocol::Hello, wire::read_line,
};
use std::{
    path::Path,
    process::Stdio,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tokio::{
    io::BufReader,
    process::{Child, ChildStderr, Command},
};

/// How long a driver has to say hello, and to end once its input is closed.
const START: Duration = Duration::from_secs(10);
const STOP: Duration = Duration::from_secs(2);
/// What a driver needs from the environment to open sockets and temporary files; nothing
/// of the person's configuration, and never a secret.
const ENVIRONMENT: &[&str] = &["SystemRoot", "windir", "TEMP", "TMP", "TMPDIR"];

pub(crate) struct DriverProcess {
    pub module: String,
    pub generation: u64,
    pub client: Client,
    pub hello: Hello,
    pub secrets: Arc<Secrets>,
    last_used: Mutex<Instant>,
    child: tokio::sync::Mutex<Child>,
}

impl DriverProcess {
    /// Starts the executable at `path` and checks it is the driver of `module`, speaking
    /// this version of the protocol.
    pub async fn start(path: &Path, generation: u64, answers: Answers) -> Result<Arc<Self>> {
        let module = answers.module.clone();
        let (secrets, log) = (answers.secrets.clone(), answers.log.clone());
        let mut command = Command::new(path);
        command
            .env_clear()
            .envs(
                ENVIRONMENT
                    .iter()
                    .filter_map(|name| Some((name, std::env::var_os(name)?))),
            )
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        // No console window for a process nobody looks at.
        #[cfg(windows)]
        command.creation_flags(0x08000000);
        let mut child = command.spawn().map_err(|error| {
            DriverError::internal(format!("The {module} driver could not be started: {error}"))
        })?;
        let pipes = (child.stdin.take(), child.stdout.take(), child.stderr.take());
        let (Some(input), Some(output), Some(errors)) = pipes else {
            return Err(DriverError::internal(format!(
                "The {module} driver started without its pipes"
            )));
        };
        tokio::spawn(log_lines(errors, module.clone(), secrets.clone(), log));
        let (peer, _) = Peer::start(output, input, |_| answers);
        let client = Client::new(peer);
        let hello = match tokio::time::timeout(START, client.hello()).await {
            Ok(Ok(hello)) => hello,
            Ok(Err(error)) => return Err(error),
            Err(_) => {
                return Err(DriverError::timeout(format!(
                    "The {module} driver did not answer when it started"
                )));
            }
        };
        if hello.protocol != PROTOCOL_VERSION || hello.driver.id != module {
            return Err(DriverError::unsupported(format!(
                "The {module} module does not match this version of Nexo; update it"
            )));
        }
        Ok(Arc::new(Self {
            module,
            generation,
            client,
            hello,
            secrets,
            last_used: Mutex::new(Instant::now()),
            child: tokio::sync::Mutex::new(child),
        }))
    }

    pub fn alive(&self) -> bool {
        !self.client.peer().is_closed()
    }
    pub fn touch(&self) {
        *self.last_used.lock().unwrap() = Instant::now();
    }
    pub fn idle_for(&self) -> Duration {
        self.last_used.lock().unwrap().elapsed()
    }

    /// Closes the driver's input, which ends it, and kills it if it does not end.
    pub async fn stop(&self) {
        self.client.peer().close();
        let mut child = self.child.lock().await;
        if tokio::time::timeout(STOP, child.wait()).await.is_err() {
            let _ = child.start_kill();
            let _ = child.wait().await;
        }
    }
}

/// Sends what the driver writes to its standard error to the log, without secrets.
async fn log_lines(errors: ChildStderr, module: String, secrets: Arc<Secrets>, log: LogSink) {
    let mut reader = BufReader::new(errors);
    let mut line = Vec::new();
    while let Ok(true) = read_line(&mut reader, &mut line).await {
        let text = String::from_utf8_lossy(&line);
        if !text.trim().is_empty() {
            log(&module, "info", &secrets.text(text.trim_end()));
        }
    }
}
