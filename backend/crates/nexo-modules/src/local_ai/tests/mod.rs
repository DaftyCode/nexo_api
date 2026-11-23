//! The local model without the network nor the real engine: downloads from a loopback server
//! (checked, refused, resumed), archives opened safely, the engine's log read, its arguments,
//! a GGUF of one's own, and removing everything.
use super::*;
use aws_lc_rs::digest::{SHA256, digest};

mod download;
mod files;

struct Open;
#[async_trait::async_trait]
impl NetworkPolicy for Open {
    async fn check_destination(&self, _: &str, _: u16) -> Result<()> {
        Ok(())
    }
    async fn resolve_destination(
        &self,
        host: &str,
        port: u16,
    ) -> Result<Vec<std::net::SocketAddr>> {
        Ok(tokio::net::lookup_host((host, port))
            .await
            .map_err(|e| Error::Infrastructure(e.to_string()))?
            .collect())
    }
    fn restrictive(&self) -> bool {
        false
    }
}

struct Fake;
impl Probe for Fake {
    fn platform(&self) -> String {
        "windows-x86_64".into()
    }
    fn nvidia_driver(&self) -> Option<u32> {
        None
    }
    fn vulkan(&self) -> bool {
        true
    }
    fn ram_free_mib(&self) -> u64 {
        16_384
    }
}

fn sha(bytes: &[u8]) -> String {
    digest(&SHA256, bytes)
        .as_ref()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

#[test]
fn the_log_says_what_fit_chose_and_the_arguments_keep_to_loopback() {
    // As llama.cpp b12641 writes it at verbosity 4.
    let mut log = server::Log::default();
    log.read("0.08.031.005 I load_tensors: offloaded 25/33 layers to GPU");
    log.read("0.11.442.361 I llama_context: n_ctx                 = 45568");
    log.read("0.11.442.362 I llama_context: n_ctx_seq             = 45568");
    log.read("0.13.758.217 I srv    load_model: initializing, n_slots = 1, n_ctx_slot = 1");
    assert_eq!(log.layers.as_deref(), Some("25/33"));
    assert_eq!(log.context, Some(45568));
    for line in 0..100 {
        log.read(&format!("line {line}"));
    }
    assert_eq!(log.lines.len(), 40);
    let arguments: Vec<String> = server::arguments(Path::new("m.gguf"), 4321, Some("Vulkan1"))
        .into_iter()
        .map(|argument| argument.to_string_lossy().into_owned())
        .collect();
    let joined = arguments.join(" ");
    assert!(joined.contains("--host 127.0.0.1 --port 4321"));
    assert!(joined.contains("--fit on --fit-target 1024"));
    assert!(joined.contains("--device Vulkan1"));
    assert!(joined.contains("--no-webui --no-agent"));
    assert!(joined.contains("--cache-ram 1024 --ctx-checkpoints 8 --log-verbosity 4"));
    assert!(
        !joined.contains("api-key"),
        "the key goes in the environment"
    );
    assert_eq!(
        probe::meminfo_available("MemTotal: 1 kB\nMemAvailable:    8388608 kB\n"),
        Some(8192)
    );
    assert_eq!(probe::meminfo_available("nothing"), None);
    assert_eq!(probe::driver_major("577.00\n"), Some(577));
    assert_eq!(probe::driver_major(""), None);
}

#[cfg(windows)]
#[tokio::test]
async fn the_engine_ends_with_nexo() {
    let mut command = tokio::process::Command::new("cmd");
    command
        .args(["/c", "ping -n 30 127.0.0.1 > nul"])
        .kill_on_drop(true);
    lifetime::before_start(&mut command);
    let child = command.spawn().unwrap();
    lifetime::after_start(&child);
    assert!(lifetime::tied(&child), "in the job closed with Nexo");
}

#[tokio::test]
async fn the_log_is_read_to_its_end_even_with_a_token_cut_in_two() {
    let log = Arc::new(std::sync::Mutex::new(server::Log::default()));
    let output: &[u8] =
        b"slot: n_gen = 100\n\xc2 half a token\nload_tensors: offloaded 3/3 layers to GPU\nlast";
    server::drain(output, log.clone()).await;
    let log = log.lock().unwrap();
    assert_eq!(log.layers.as_deref(), Some("3/3"));
    assert_eq!(log.lines.len(), 4);
    assert_eq!(log.lines[1], "\u{fffd} half a token");
    assert_eq!(log.lines[3], "last");
}

/// Counts how often the NVIDIA driver is asked for, as `nvidia-smi` takes seconds.
struct Counted(std::sync::atomic::AtomicUsize);
impl Probe for Counted {
    fn platform(&self) -> String {
        "windows-x86_64".into()
    }
    fn nvidia_driver(&self) -> Option<u32> {
        self.0.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        Some(590)
    }
    fn vulkan(&self) -> bool {
        true
    }
    fn ram_free_mib(&self) -> u64 {
        16_384
    }
}

#[tokio::test]
async fn the_hardware_is_read_once_for_every_call() {
    use nexo_application::ports::LocalModel;
    let root = std::env::temp_dir().join(format!("nexo-ai-{}", uuid::Uuid::new_v4()));
    let probe = Arc::new(Counted(Default::default()));
    let models = LocalModels::new(root.clone(), Arc::new(Open), probe.clone()).unwrap();
    let (first, second, third) = tokio::join!(models.status(), models.status(), models.status());
    assert_eq!(first.unwrap().backend, "cuda");
    assert!(second.is_ok() && third.is_ok());
    models.status().await.unwrap();
    assert_eq!(probe.0.load(std::sync::atomic::Ordering::SeqCst), 1);
    let _ = std::fs::remove_dir_all(root);
}
