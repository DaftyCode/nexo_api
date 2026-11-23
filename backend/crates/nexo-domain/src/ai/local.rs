//! The model run inside Nexo (IA-01): what is downloaded (llama.cpp's `llama-server` and a
//! Qwen3.5 GGUF from unsloth, each with its SHA-256 fixed here), and which model fits the
//! memory the computer has free. `llama-server --fit` then sets the layers on the GPU and the
//! context to the memory free when it loads; this only picks the model and the GPU.
use crate::{Error, Result};

/// The build of llama.cpp Nexo runs.
pub const ENGINE_BUILD: &str = "b12641";
/// Memory `--fit` keeps free on the GPU, in MiB.
pub const FIT_MARGIN_MIB: u64 = 1024;
/// Memory left to the system and its other programs, in MiB.
const SYSTEM_RAM_MIB: u64 = 2048;
/// What a model needs besides its file (context, buffers), in MiB.
const RUNTIME_MIB: u64 = 800;

/// How the engine reaches the hardware.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Backend {
    Cuda,
    Vulkan,
    Metal,
    Cpu,
}

impl Backend {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Cuda => "cuda",
            Self::Vulkan => "vulkan",
            Self::Metal => "metal",
            Self::Cpu => "cpu",
        }
    }
    pub fn parse(text: &str) -> Option<Self> {
        [Self::Cuda, Self::Vulkan, Self::Metal, Self::Cpu]
            .into_iter()
            .find(|backend| backend.as_str() == text)
    }
}

/// A file to download, with its size and SHA-256.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Asset {
    pub url: &'static str,
    pub size: u64,
    pub sha256: &'static str,
}

macro_rules! asset {
    ($file:literal, $size:literal, $sha:literal) => {
        Asset {
            url: concat!(
                "https://github.com/ggml-org/llama.cpp/releases/download/b12641/",
                $file
            ),
            size: $size,
            sha256: $sha,
        }
    };
}

/// The archives of the engine for a platform (`windows-x86_64`) and a backend; the CUDA build
/// comes with the CUDA runtime in a second archive.
pub fn engine(platform: &str, backend: Backend) -> Option<&'static [Asset]> {
    const WINDOWS_CUDA: [Asset; 2] = [
        asset!(
            "llama-b12641-bin-win-cuda-13.5-x64.zip",
            225_698_757,
            "ba3023ff68e34f1229702dc5bbcbd2011c3487051e29e444f2bb991d2993a6d3"
        ),
        asset!(
            "cudart-llama-bin-win-cuda-13.5-x64.zip",
            426_314_199,
            "c2bf4cc202bfbaaa7a0b75f5082457c3811326947bb216059b72839d844e9cba"
        ),
    ];
    const WINDOWS_VULKAN: [Asset; 1] = [asset!(
        "llama-b12641-bin-win-vulkan-x64.zip",
        38_935_891,
        "f401aa7cdcd0a540520afbddff6f49c6dd50184571a7cb3f3039d3451e058d5e"
    )];
    const WINDOWS_CPU: [Asset; 1] = [asset!(
        "llama-b12641-bin-win-cpu-x64.zip",
        25_093_477,
        "83d7190d004922080667e2310cb988fde39d96db152b7d68e05bb6ee238527e8"
    )];
    const LINUX_CUDA: [Asset; 2] = [
        asset!(
            "llama-b12641-bin-ubuntu-cuda-13.5-x64.tar.gz",
            224_478_037,
            "58b3b7396ecd393512e7b96549ef2c3b2dfb44a90faf863adffb99017373b87c"
        ),
        asset!(
            "cudart-llama-b12641-bin-ubuntu-cuda-13.5-x64.tar.gz",
            444_078_769,
            "e707dbacb3f867810c2f6e2c13b5302688fdbf8bff50af721ca5c6816e074e29"
        ),
    ];
    const LINUX_VULKAN: [Asset; 1] = [asset!(
        "llama-b12641-bin-ubuntu-vulkan-x64.tar.gz",
        36_975_107,
        "6641fe1fdc9a942eca8c88499c9187f00b55fe3512d94bac63790fb4ad1cb01d"
    )];
    const LINUX_CPU: [Asset; 1] = [asset!(
        "llama-b12641-bin-ubuntu-x64.tar.gz",
        23_299_298,
        "4b32a3741d317a7ba39b1eda5258cd47a0a90f16c7d60785b8733150ff2d598a"
    )];
    const MAC_METAL: [Asset; 1] = [asset!(
        "llama-b12641-bin-macos-arm64.tar.gz",
        16_643_557,
        "8000c0ae9afc4e064cf3240df9aa39e751fd9c377a35c42798e93547e9d61b49"
    )];
    Some(match (platform, backend) {
        ("windows-x86_64", Backend::Cuda) => &WINDOWS_CUDA,
        ("windows-x86_64", Backend::Vulkan) => &WINDOWS_VULKAN,
        ("windows-x86_64", Backend::Cpu) => &WINDOWS_CPU,
        ("linux-x86_64", Backend::Cuda) => &LINUX_CUDA,
        ("linux-x86_64", Backend::Vulkan) => &LINUX_VULKAN,
        ("linux-x86_64", Backend::Cpu) => &LINUX_CPU,
        ("macos-aarch64", Backend::Metal) => &MAC_METAL,
        _ => return None,
    })
}

/// The NVIDIA driver the CUDA 13 build needs (its major version).
pub const CUDA_DRIVER: u32 = 580;

/// The backend for what the computer has: CUDA with an NVIDIA driver new enough for it, Metal
/// on a Mac with Apple silicon, Vulkan for the other GPUs (and older NVIDIA drivers), and the
/// CPU without any.
pub fn backend(platform: &str, nvidia_driver: Option<u32>, vulkan: bool) -> Backend {
    match platform {
        "macos-aarch64" => Backend::Metal,
        _ if nvidia_driver.is_some_and(|major| major >= CUDA_DRIVER) => Backend::Cuda,
        _ if vulkan => Backend::Vulkan,
        _ => Backend::Cpu,
    }
}

/// A model Nexo downloads, from a fixed revision of its repository on Hugging Face.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Model {
    pub id: &'static str,
    pub name: &'static str,
    pub url: &'static str,
    pub size: u64,
    pub sha256: &'static str,
}

pub const MODELS: [Model; 2] = [
    Model {
        id: "qwen3.5-9b",
        name: "Qwen3.5-9B",
        url: "https://huggingface.co/unsloth/Qwen3.5-9B-GGUF/resolve/3885219b6810b007914f3a7950a8d1b469d598a5/Qwen3.5-9B-Q4_K_M.gguf",
        size: 5_680_522_464,
        sha256: "03b74727a860a56338e042c4420bb3f04b2fec5734175f4cb9fa853daf52b7e8",
    },
    Model {
        id: "qwen3.5-4b",
        name: "Qwen3.5-4B",
        url: "https://huggingface.co/unsloth/Qwen3.5-4B-GGUF/resolve/e87f176479d0855a907a41277aca2f8ee7a09523/Qwen3.5-4B-Q4_K_M.gguf",
        size: 2_740_937_888,
        sha256: "00fe7986ff5f6b463e62455821146049db6f9313603938a70800d1fb69ef11a4",
    },
];

pub fn model(id: &str) -> Result<&'static Model> {
    MODELS
        .iter()
        .find(|model| model.id == id)
        .ok_or_else(|| Error::Validation(format!("Nexo has no local model {id}")))
}

/// The hosts the downloads go to, and nowhere else: the releases of llama.cpp and Hugging
/// Face with its CDN.
pub const DOWNLOAD_HOSTS: [&str; 5] = [
    "github.com",
    "release-assets.githubusercontent.com",
    "objects.githubusercontent.com",
    "huggingface.co",
    "*.hf.co",
];

/// A device `llama-server --list-devices` lists, with its memory in MiB.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Device {
    /// How llama.cpp names it: `CUDA0`, `Vulkan1`.
    pub id: String,
    pub name: String,
    pub total_mib: u64,
    pub free_mib: u64,
}

/// The devices of `llama-server --list-devices`: lines such as
/// `  Vulkan1: NVIDIA GeForce RTX 3060 Laptop GPU (5996 MiB, 5228 MiB free)`.
pub fn devices(listed: &str) -> Vec<Device> {
    listed
        .lines()
        .filter_map(|line| {
            let (id, rest) = line.trim().split_once(": ")?;
            let open = rest.rfind(" (")?;
            let (name, memory) = (&rest[..open], rest[open + 2..].trim_end_matches(')'));
            let (total, free) = memory.split_once(", ")?;
            let mib = |text: &str| text.split_whitespace().next()?.parse::<u64>().ok();
            if id.contains(' ') || !free.ends_with("free") {
                return None;
            }
            Some(Device {
                id: id.to_owned(),
                name: name.trim().to_owned(),
                total_mib: mib(total)?,
                free_mib: mib(free)?,
            })
        })
        .collect()
}

/// The GPU to run on: a CUDA device first, then a GPU of NVIDIA or AMD, then any; within
/// each, the one with the most memory free. The graphics built into a processor share the
/// RAM, so they come last even when they report more memory.
pub fn device(devices: &[Device]) -> Option<&Device> {
    let rank = |device: &Device| {
        let name = device.name.to_ascii_lowercase();
        if device.id.starts_with("CUDA") {
            0
        } else if name.contains("nvidia")
            || name.contains("radeon rx")
            || name.contains("radeon pro")
        {
            1
        } else {
            2
        }
    };
    devices
        .iter()
        .min_by_key(|device| (rank(device), u64::MAX - device.free_mib))
}

/// Which model fits, and why.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Plan {
    pub model: &'static Model,
    /// The whole model fits on the GPU; otherwise part of it runs on the CPU.
    pub whole_on_gpu: bool,
    /// Why it was chosen, as the interface says it (`ai.local.why.*`).
    pub reason: &'static str,
}

fn need_mib(model: &Model) -> u64 {
    model.size.div_ceil(1 << 20) + RUNTIME_MIB
}

/// The model for `gpu_free_mib` of free memory on the chosen GPU and `ram_free_mib` of free
/// RAM: the 9B when it fits on the GPU, whole or for three quarters with the rest in RAM; the
/// 4B otherwise; an error when not even the 4B fits.
pub fn plan(gpu_free_mib: u64, ram_free_mib: u64) -> Result<Plan> {
    let gpu = gpu_free_mib.saturating_sub(FIT_MARGIN_MIB);
    let ram = ram_free_mib.saturating_sub(SYSTEM_RAM_MIB);
    let [large, small] = &MODELS;
    let (need_large, need_small) = (need_mib(large), need_mib(small));
    let found = if gpu >= need_large {
        (large, true, "ai.local.why.gpu")
    } else if gpu * 4 >= need_large * 3 && gpu + ram >= need_large {
        (large, false, "ai.local.why.mostly")
    } else if gpu >= need_small {
        (small, true, "ai.local.why.smallGpu")
    } else if gpu + ram >= need_small {
        (small, false, "ai.local.why.small")
    } else {
        return Err(Error::Validation(format!(
            "This computer has {} MiB free: a local model needs at least {} MiB",
            gpu_free_mib + ram_free_mib,
            need_small + FIT_MARGIN_MIB + SYSTEM_RAM_MIB
        )));
    };
    Ok(Plan {
        model: found.0,
        whole_on_gpu: found.1,
        reason: found.2,
    })
}

#[cfg(test)]
mod tests;
