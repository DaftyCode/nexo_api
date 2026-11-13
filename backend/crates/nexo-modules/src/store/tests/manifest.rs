//! The manifest and where downloads may go.
use super::*;

#[test]
fn a_manifest_is_trusted_only_for_its_version_and_platform() {
    let (entry, _) = module("pg", b"driver");
    let text = |modules: Vec<ModuleEntry>| {
        serde_json::to_string(&Manifest {
            version: VERSION.into(),
            target: TARGET.into(),
            modules,
        })
        .unwrap()
    };
    let manifest = Manifest::parse(&text(vec![entry.clone()]), VERSION, TARGET).unwrap();
    assert_eq!(manifest.entry("pg"), Some(&entry));
    assert!(
        Manifest::parse("", VERSION, TARGET)
            .unwrap()
            .modules
            .is_empty()
    );
    assert!(
        Manifest::parse(&text(vec![]), "9.9.9", TARGET)
            .unwrap_err()
            .contains("not 9.9.9")
    );
    assert!(Manifest::parse(&text(vec![]), VERSION, "other").is_err());
    let wrong = [
        ModuleEntry {
            id: "../pg".into(),
            ..entry.clone()
        },
        ModuleEntry {
            file: "../../evil.gz".into(),
            ..entry.clone()
        },
        ModuleEntry {
            file: "dir/file.gz".into(),
            ..entry.clone()
        },
        ModuleEntry {
            sha256: "ABC".into(),
            ..entry.clone()
        },
        ModuleEntry {
            compressed_sha256: "0".repeat(63),
            ..entry.clone()
        },
        ModuleEntry {
            protocol: 99,
            ..entry.clone()
        },
        ModuleEntry {
            size: 0,
            ..entry.clone()
        },
    ];
    for wrong in wrong {
        assert!(
            Manifest::parse(&text(vec![wrong.clone()]), VERSION, TARGET).is_err(),
            "{wrong:?}"
        );
    }
    assert!(Manifest::parse(&text(vec![entry.clone(), entry]), VERSION, TARGET).is_err());
    assert!(Manifest::parse(r#"{"version": "1.2.3"}"#, VERSION, TARGET).is_err());
}

#[test]
fn the_embedded_manifest_belongs_to_this_build() {
    let manifest = Manifest::embedded();
    assert_eq!(manifest.version, env!("CARGO_PKG_VERSION"));
    assert!(!manifest.target.is_empty());
}

#[test]
fn downloads_go_only_to_the_release_hosts() {
    let hosts = AllowedHosts::stored(&["github.com", "*.githubusercontent.com"]);
    let allowed = |url: &str| crate::download::allowed(&Url::parse(url).unwrap(), &hosts, "https");
    assert!(allowed("https://github.com/o/r/releases/download/v1/x.gz"));
    assert!(allowed(
        "https://release-assets.githubusercontent.com/x?sig=1"
    ));
    for refused in [
        "http://github.com/x",
        "https://github.com.evil.test/x",
        "https://githubusercontent.com/x",
        "https://evil.test/github.com",
        "https://127.0.0.1/x",
    ] {
        assert!(!allowed(refused), "{refused}");
    }
}
