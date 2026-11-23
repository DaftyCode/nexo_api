use super::*;

const LISTED: &str = "ggml_vulkan: Found 2 Vulkan devices:\n\
Available devices:\n  \
Vulkan0: Intel(R) Iris(R) Xe Graphics (20325 MiB, 20325 MiB free)\n  \
Vulkan1: NVIDIA GeForce RTX 3060 Laptop GPU (5996 MiB, 5228 MiB free)\n";

#[test]
fn the_devices_are_read_from_llama_server() {
    let found = devices(LISTED);
    assert_eq!(found.len(), 2);
    assert_eq!(
        found[1],
        Device {
            id: "Vulkan1".into(),
            name: "NVIDIA GeForce RTX 3060 Laptop GPU".into(),
            total_mib: 5996,
            free_mib: 5228,
        }
    );
    assert!(devices("load_backend: loaded CPU backend from x.dll\nno devices").is_empty());
    assert!(devices("  CUDA0: Broken (lots, 12 MiB free)").is_empty());
}

#[test]
fn a_dedicated_gpu_is_chosen_before_the_one_in_the_processor() {
    let found = devices(LISTED);
    assert_eq!(device(&found).unwrap().id, "Vulkan1");
    let cuda = devices(
        "  CUDA0: NVIDIA RTX 4090 (24564 MiB, 1000 MiB free)\n  Vulkan0: AMD Radeon RX 7900 (24000 MiB, 20000 MiB free)",
    );
    assert_eq!(device(&cuda).unwrap().id, "CUDA0");
    let two = devices(
        "  Vulkan0: AMD Radeon RX 6600 (8176 MiB, 7000 MiB free)\n  Vulkan1: AMD Radeon RX 7900 (24000 MiB, 20000 MiB free)",
    );
    assert_eq!(device(&two).unwrap().id, "Vulkan1");
    let apple = devices("  MTL0: Apple M2 (16384 MiB, 12000 MiB free)");
    assert_eq!(device(&apple).unwrap().id, "MTL0");
    assert!(device(&[]).is_none());
}

#[test]
fn the_model_fits_the_free_memory() {
    // (free VRAM, free RAM) → model, whole on the GPU, reason.
    let cases: [(u64, u64, &str, bool, &str); 9] = [
        // 16 GB free: the 9B whole.
        (16_384, 16_384, "qwen3.5-9b", true, "ai.local.why.gpu"),
        // 8 GB, free.
        (8_192, 8_192, "qwen3.5-9b", true, "ai.local.why.gpu"),
        // 8 GB of which another program takes 1.2: three quarters of the 9B on the GPU.
        (7_000, 8_192, "qwen3.5-9b", false, "ai.local.why.mostly"),
        // 8 GB of which another program takes 2.5: the 4B, whole, rather than half the 9B.
        (5_632, 8_192, "qwen3.5-4b", true, "ai.local.why.smallGpu"),
        // The owner's RTX 3060 laptop (6 GB, 5.2 free): the 4B whole on the GPU.
        (5_228, 8_000, "qwen3.5-4b", true, "ai.local.why.smallGpu"),
        // A 4 GB card: the 4B, part of it on the CPU.
        (4_096, 4_096, "qwen3.5-4b", false, "ai.local.why.small"),
        // 8 GB mostly taken, little RAM: the 4B, part on the CPU.
        (3_000, 4_000, "qwen3.5-4b", false, "ai.local.why.small"),
        // Only the CPU, with RAM.
        (0, 16_384, "qwen3.5-4b", false, "ai.local.why.small"),
        // Unified memory (a Mac): the GPU's free memory is the RAM, counted once.
        (12_000, 0, "qwen3.5-9b", true, "ai.local.why.gpu"),
    ];
    for (gpu, ram, id, whole, reason) in cases {
        let found = plan(gpu, ram).unwrap();
        assert_eq!(
            (found.model.id, found.whole_on_gpu, found.reason),
            (id, whole, reason),
            "{gpu} MiB of VRAM and {ram} of RAM"
        );
    }
    let short = plan(1_000, 3_000).unwrap_err();
    assert!(short.to_string().contains("needs at least"));
}

#[test]
fn each_platform_has_its_engine_and_backend() {
    assert_eq!(backend("windows-x86_64", Some(591), true), Backend::Cuda);
    // The owner's driver 577 is too old for CUDA 13: Vulkan, which NVIDIA cards run too.
    assert_eq!(backend("windows-x86_64", Some(577), true), Backend::Vulkan);
    assert_eq!(backend("linux-x86_64", None, true), Backend::Vulkan);
    assert_eq!(backend("windows-x86_64", None, false), Backend::Cpu);
    assert_eq!(backend("macos-aarch64", None, false), Backend::Metal);
    assert_eq!(engine("windows-x86_64", Backend::Cuda).unwrap().len(), 2);
    let vulkan = engine("windows-x86_64", Backend::Vulkan).unwrap();
    assert!(
        vulkan[0]
            .url
            .starts_with("https://github.com/ggml-org/llama.cpp/releases/download/b12641/")
    );
    assert_eq!(vulkan[0].sha256.len(), 64);
    assert!(engine("macos-aarch64", Backend::Cuda).is_none());
    assert!(engine("freebsd-x86_64", Backend::Cpu).is_none());
    for backend in [Backend::Cuda, Backend::Vulkan, Backend::Metal, Backend::Cpu] {
        assert_eq!(Backend::parse(backend.as_str()), Some(backend));
    }
    assert_eq!(Backend::parse("rocm"), None);
}

#[test]
fn the_models_are_fixed_with_their_hash() {
    assert_eq!(model("qwen3.5-4b").unwrap().name, "Qwen3.5-4B");
    assert!(model("llama").is_err());
    for model in MODELS {
        assert!(model.url.starts_with("https://huggingface.co/unsloth/"));
        assert!(model.url.contains("/resolve/"), "a fixed revision");
        assert_eq!(model.sha256.len(), 64);
    }
    let hosts = crate::hosts::AllowedHosts::parse(&DOWNLOAD_HOSTS.map(String::from)).unwrap();
    assert!(hosts.allows("us.aws.cdn.hf.co"));
    assert!(!hosts.allows("hf.co.evil.test"));
}
