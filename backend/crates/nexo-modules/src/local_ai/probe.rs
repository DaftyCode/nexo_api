//! What the computer has for the local model, before its engine is downloaded: an NVIDIA
//! driver (for the CUDA build), Vulkan (for the other GPUs) and the free RAM. The free memory
//! of each GPU comes later, from the engine itself (`llama-server --list-devices`).
use std::path::Path;

pub trait Probe: Send + Sync {
    /// `windows-x86_64`, `linux-x86_64`, `macos-aarch64`…
    fn platform(&self) -> String;
    /// The major version of the NVIDIA driver, when there is one.
    fn nvidia_driver(&self) -> Option<u32>;
    fn vulkan(&self) -> bool;
    /// RAM free for programs, in MiB; 0 where the GPU shares it (Apple silicon).
    fn ram_free_mib(&self) -> u64;
}

/// The computer Nexo runs on.
pub struct SystemProbe;

impl Probe for SystemProbe {
    fn platform(&self) -> String {
        format!("{}-{}", std::env::consts::OS, std::env::consts::ARCH)
    }
    fn nvidia_driver(&self) -> Option<u32> {
        let installed = if cfg!(windows) {
            system32().is_some_and(|folder| folder.join("nvcuda.dll").is_file())
        } else {
            Path::new("/proc/driver/nvidia/version").is_file()
        };
        if !installed {
            return None;
        }
        // `nvidia-smi` comes with the driver; its answer is `577.00`.
        let mut command = std::process::Command::new("nvidia-smi");
        command.args(["--query-gpu=driver_version", "--format=csv,noheader"]);
        #[cfg(windows)]
        std::os::windows::process::CommandExt::creation_flags(&mut command, 0x08000000);
        let output = command.output().ok()?;
        driver_major(&String::from_utf8_lossy(&output.stdout))
    }
    fn vulkan(&self) -> bool {
        if cfg!(windows) {
            system32().is_some_and(|folder| folder.join("vulkan-1.dll").is_file())
        } else {
            [
                "/usr/lib/x86_64-linux-gnu/libvulkan.so.1",
                "/usr/lib64/libvulkan.so.1",
                "/usr/lib/libvulkan.so.1",
                "/lib/x86_64-linux-gnu/libvulkan.so.1",
            ]
            .iter()
            .any(|path| Path::new(path).is_file())
        }
    }
    fn ram_free_mib(&self) -> u64 {
        ram_free_mib()
    }
}

#[cfg(windows)]
fn system32() -> Option<std::path::PathBuf> {
    let root = std::env::var_os("SystemRoot")?;
    Some(Path::new(&root).join("System32"))
}
#[cfg(not(windows))]
fn system32() -> Option<std::path::PathBuf> {
    None
}

#[cfg(windows)]
fn ram_free_mib() -> u64 {
    use windows_sys::Win32::System::SystemInformation::{GlobalMemoryStatusEx, MEMORYSTATUSEX};
    // SAFETY: a structure of plain numbers, all zero before Windows fills it.
    let mut status: MEMORYSTATUSEX = unsafe { std::mem::zeroed() };
    status.dwLength = std::mem::size_of::<MEMORYSTATUSEX>() as u32;
    // SAFETY: the structure is the size Windows expects, as its `dwLength` says.
    if unsafe { GlobalMemoryStatusEx(&mut status) } == 0 {
        return 0;
    }
    status.ullAvailPhys / (1 << 20)
}

#[cfg(target_os = "linux")]
fn ram_free_mib() -> u64 {
    std::fs::read_to_string("/proc/meminfo")
        .ok()
        .and_then(|text| meminfo_available(&text))
        .unwrap_or(0)
}

#[cfg(not(any(windows, target_os = "linux")))]
fn ram_free_mib() -> u64 {
    0
}

/// The major version of the first driver `nvidia-smi` names.
pub(crate) fn driver_major(text: &str) -> Option<u32> {
    text.lines().next()?.trim().split('.').next()?.parse().ok()
}

/// `MemAvailable` of `/proc/meminfo`, in MiB.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
pub(crate) fn meminfo_available(text: &str) -> Option<u64> {
    let line = text
        .lines()
        .find(|line| line.starts_with("MemAvailable:"))?;
    let kib: u64 = line.split_whitespace().nth(1)?.parse().ok()?;
    Some(kib / 1024)
}
