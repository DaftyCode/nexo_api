use super::*;
use crate::catalog::{Manifest, ModuleEntry};
use flate2::{Compression, write::GzEncoder};
use std::io::Write;

mod manifest;

const VERSION: &str = "1.2.3";
const TARGET: &str = "x86_64-test";

fn gzip(bytes: &[u8]) -> Vec<u8> {
    let mut encoder = GzEncoder::new(Vec::new(), Compression::default());
    encoder.write_all(bytes).unwrap();
    encoder.finish().unwrap()
}

/// A module whose "driver" is `driver`, and its release asset.
fn module(id: &str, driver: &[u8]) -> (ModuleEntry, Vec<u8>) {
    let asset = gzip(driver);
    let entry = ModuleEntry {
        id: id.into(),
        name: format!("Module {id}"),
        description: "For the tests".into(),
        version: VERSION.into(),
        protocol: nexo_driver_sdk::PROTOCOL_VERSION,
        file: format!("nexo-driver-{id}-{TARGET}.gz"),
        size: driver.len() as u64,
        sha256: sha256(driver),
        compressed_size: asset.len() as u64,
        compressed_sha256: sha256(&asset),
        licenses: vec!["MIT".into()],
    };
    (entry, asset)
}

struct Fixture {
    folder: PathBuf,
    store: ModuleStore,
    entry: ModuleEntry,
    asset: Vec<u8>,
    driver: Vec<u8>,
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.folder);
    }
}

fn fixture_with(change: impl FnOnce(&mut StoreConfig, &Path)) -> Fixture {
    let folder =
        std::env::temp_dir().join(format!("nexo-modules-{}", uuid::Uuid::new_v4().simple()));
    fs::create_dir_all(&folder).unwrap();
    let driver = b"\x7fELF not really a driver".repeat(100);
    let (entry, asset) = module("pg", &driver);
    let mut config = StoreConfig {
        root: folder.join("data/modules"),
        manifest: Manifest {
            version: VERSION.into(),
            target: TARGET.into(),
            modules: vec![entry.clone()],
        },
        source: Url::parse("https://github.com/owner/repo/releases/download/v1.2.3/").unwrap(),
        hosts: AllowedHosts::stored(&["github.com"]),
        bundled: None,
        development: None,
    };
    change(&mut config, &folder);
    Fixture {
        store: ModuleStore::new(config),
        folder,
        entry,
        asset,
        driver,
    }
}
fn fixture() -> Fixture {
    fixture_with(|_, _| {})
}
fn state(fixture: &Fixture) -> ModuleState {
    fixture.store.summary(&fixture.entry).state
}

#[test]
fn installs_a_checked_driver_and_runs_it_only_while_it_matches() {
    let fixture = fixture();
    let store = &fixture.store;
    assert_eq!(state(&fixture), ModuleState::Available);
    assert!(
        store
            .executable_path("pg")
            .unwrap_err()
            .to_string()
            .contains("not installed")
    );

    let driver = unpack(&fixture.entry, &fixture.asset).unwrap();
    store.commit(&fixture.entry, &driver).unwrap();
    assert_eq!(state(&fixture), ModuleState::Installed);
    let path = store.executable_path("pg").unwrap();
    assert_eq!(
        path,
        fixture
            .folder
            .join("data/modules/pg/1.2.3")
            .join(executable_name("pg"))
    );
    assert_eq!(fs::read(&path).unwrap(), fixture.driver);
    // Nothing else is left in its folder.
    assert_eq!(fs::read_dir(path.parent().unwrap()).unwrap().count(), 1);

    // Changed on disk after it was installed: it is deleted, never run.
    fs::write(&path, b"something else").unwrap();
    let error = store.executable_path("pg").unwrap_err().to_string();
    assert!(error.contains("changed on disk"), "{error}");
    assert!(!path.exists());
    assert_eq!(state(&fixture), ModuleState::Outdated);
}

#[test]
fn refuses_files_that_are_not_what_the_manifest_says() {
    let fixture = fixture();
    let entry = &fixture.entry;
    let mut changed = fixture.asset.clone();
    let last = changed.len() - 1;
    changed[last] ^= 1;
    for asset in [
        &changed[..],
        &fixture.asset[..fixture.asset.len() - 1],
        b"plain text",
    ] {
        assert!(unpack(entry, asset).is_err());
    }
    // An asset with the expected hash whose contents are larger than the manifest says
    // (a manifest written for a smaller driver) stops at the size it expects.
    let large = gzip(&vec![0; 10 * 1024 * 1024]);
    let lying = ModuleEntry {
        compressed_size: large.len() as u64,
        compressed_sha256: sha256(&large),
        ..entry.clone()
    };
    let error = unpack(&lying, &large).unwrap_err().to_string();
    assert!(error.contains("not the one"), "{error}");
    // A driver with another hash is never written.
    let error = fixture.store.commit(entry, b"another driver").unwrap_err();
    assert!(error.to_string().contains("not the one"));
    assert!(!fixture.folder.join("data/modules/pg").exists());
}

#[test]
fn recognises_a_chosen_file_by_its_hash() {
    let fixture = fixture();
    let (entry, driver) = fixture.store.recognise(&fixture.asset).unwrap();
    assert_eq!((entry.id.as_str(), &driver), ("pg", &fixture.driver));
    let (entry, driver) = fixture.store.recognise(&fixture.driver).unwrap();
    assert_eq!((entry.id.as_str(), &driver), ("pg", &fixture.driver));
    let error = fixture
        .store
        .recognise(b"some other program")
        .unwrap_err()
        .to_string();
    assert_eq!(
        error,
        "This file is not a module of Nexo 1.2.3 for this computer"
    );
}

#[test]
fn an_older_version_is_outdated_and_goes_when_this_one_is_installed() {
    let fixture = fixture();
    let old = fixture.folder.join("data/modules/pg/1.0.0");
    fs::create_dir_all(&old).unwrap();
    fs::write(old.join(executable_name("pg")), b"old driver").unwrap();
    fs::create_dir_all(fixture.folder.join("data/modules/pg/1.2.3")).unwrap();
    let partial = fixture
        .folder
        .join("data/modules/pg/1.2.3/.driver.partial-123");
    fs::write(&partial, b"half").unwrap();
    assert_eq!(state(&fixture), ModuleState::Outdated);
    fixture
        .store
        .commit(&fixture.entry, &fixture.driver)
        .unwrap();
    assert_eq!(state(&fixture), ModuleState::Installed);
    assert!(!old.exists() && !partial.exists());

    fixture.store.remove_files("pg").unwrap();
    assert!(!fixture.folder.join("data/modules/pg").exists());
    assert_eq!(state(&fixture), ModuleState::Available);
    // Removing what is not there is not an error.
    fixture.store.remove_files("pg").unwrap();
}

#[test]
fn a_bundled_copy_is_installed_when_the_module_is_first_used() {
    for asset in [true, false] {
        let fixture = fixture_with(|config, folder| config.bundled = Some(folder.join("bundle")));
        let bundle = fixture.folder.join("bundle");
        fs::create_dir_all(&bundle).unwrap();
        let (name, bytes) = if asset {
            (fixture.entry.file.clone(), fixture.asset.clone())
        } else {
            (executable_name("pg"), fixture.driver.clone())
        };
        fs::write(bundle.join(name), bytes).unwrap();
        let summary = fixture.store.summary(&fixture.entry);
        assert!(summary.bundled && summary.state == ModuleState::Available);
        let path = fixture.store.executable_path("pg").unwrap();
        assert_eq!(fs::read(path).unwrap(), fixture.driver);
        assert_eq!(state(&fixture), ModuleState::Installed);
    }
    // A bundled file that does not match is not installed.
    let fixture = fixture_with(|config, folder| config.bundled = Some(folder.join("bundle")));
    fs::create_dir_all(fixture.folder.join("bundle")).unwrap();
    fs::write(
        fixture.folder.join("bundle").join(executable_name("pg")),
        b"tampered",
    )
    .unwrap();
    assert!(fixture.store.executable_path("pg").is_err());
    assert_eq!(state(&fixture), ModuleState::Available);
}

#[test]
fn development_drivers_run_as_they_are() {
    let fixture = fixture_with(|config, folder| config.development = Some(folder.join("debug")));
    let debug = fixture.folder.join("debug");
    fs::create_dir_all(&debug).unwrap();
    for name in [
        executable_name("pg"),
        executable_name("test"),
        "nexo-server.d".into(),
        "readme.txt".into(),
    ] {
        fs::write(debug.join(name), b"built by cargo").unwrap();
    }
    assert_eq!(
        fixture.store.executable_path("test").unwrap(),
        debug.join(executable_name("test"))
    );
    // It wins over the manifest: a developer runs what they just built.
    assert_eq!(
        fixture.store.executable_path("pg").unwrap(),
        debug.join(executable_name("pg"))
    );
    let summaries = fixture.store.summaries();
    let listed: Vec<(&str, ModuleState)> =
        summaries.iter().map(|s| (s.id.as_str(), s.state)).collect();
    assert_eq!(
        listed,
        [
            ("pg", ModuleState::Development),
            ("test", ModuleState::Development)
        ]
    );
    assert!(fixture.store.is_development("test"));
}

#[test]
fn refuses_module_names_that_are_paths() {
    let fixture = fixture();
    for name in ["", "../pg", "pg/../../x", "PG", "-pg", "pg.exe"] {
        assert!(fixture.store.executable_path(name).is_err(), "{name}");
    }
}
