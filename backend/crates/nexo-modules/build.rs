//! Embeds the manifest of the database modules of this build: the drivers the release
//! publishes for this platform, with their hashes. CI writes it before it builds the app
//! (`tools/package-modules.mjs`) and names it in `NEXO_MODULES_MANIFEST`; without it, the
//! build has no modules to download.
use std::{env, fs, path::PathBuf};

fn main() {
    println!("cargo:rerun-if-env-changed=NEXO_MODULES_MANIFEST");
    let manifest = match env::var_os("NEXO_MODULES_MANIFEST") {
        Some(path) => {
            let path = PathBuf::from(path);
            println!("cargo:rerun-if-changed={}", path.display());
            fs::read_to_string(&path).unwrap_or_else(|error| {
                panic!("NEXO_MODULES_MANIFEST names {}: {error}", path.display())
            })
        }
        None => String::new(),
    };
    let out = PathBuf::from(env::var_os("OUT_DIR").expect("Cargo sets OUT_DIR"));
    fs::write(out.join("modules.json"), manifest).expect("OUT_DIR is writable");
    // The platform the manifest must be for.
    let target = env::var("TARGET").expect("Cargo sets TARGET");
    println!("cargo:rustc-env=NEXO_MODULES_TARGET={target}");
}
