use super::*;
fn directory() -> PathBuf {
    let path = std::env::temp_dir().join(format!("nexo-vault-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&path).unwrap();
    path
}
#[tokio::test]
async fn stores_lists_and_removes_secrets() {
    let dir = directory();
    let vault = Vault::new(dir.clone(), [7; 32], "local");
    vault.put("token", "value").await.unwrap();
    assert_eq!(vault.get("token").await.unwrap(), "value");
    assert_eq!(vault.names().await.unwrap(), ["token"]);
    vault.remove("token").await.unwrap();
    assert!(vault.get("token").await.is_err());
    assert!(vault.put("__proto__", "x").await.is_err());
    assert!(vault.put("a}b", "x").await.is_err());
    let _ = std::fs::remove_dir_all(dir);
}
#[tokio::test]
async fn concurrent_writes_are_not_lost() {
    let dir = directory();
    let vault = std::sync::Arc::new(Vault::new(dir.clone(), [1; 32], "local"));
    let tasks: Vec<_> = (0..30)
        .map(|index| {
            let vault = vault.clone();
            tokio::spawn(async move { vault.put(&format!("s{index}"), "v").await.unwrap() })
        })
        .collect();
    for task in tasks {
        task.await.unwrap();
    }
    assert_eq!(vault.names().await.unwrap().len(), 30);
    let _ = std::fs::remove_dir_all(dir);
}
/// Vault files written with an independent AES-256-GCM (Node's crypto) in the formats
/// Nexo reads: version 2 with its AAD, a version 1 entry, and the previous engine's file.
/// They pin the format: any change of cipher must still read them.
const VERSION_2_FILE: &str = r#"{"version":2,"secrets":{"api":{"v":2,"iv":"010101010101010101010101","tag":"f07845919842c7bb1fc1630b302af730","data":"ca43e2177693e8928ddd7fbb84e3f576"},"legacy":{"iv":"020202020202020202020202","tag":"06eaa808e2cf8ab5a66b793cf01a7b56","data":"9c6689197e34a1"}}}"#;
const NODE_ENGINE_FILE: &str = r#"{"old":{"iv":"030303030303030303030303","tag":"fc9e13fb5407b4123d1d507e6af677e5","data":"a6e6820621d9058cb9db8f3b835cb7"}}"#;

#[tokio::test]
async fn reads_the_pinned_vault_files() {
    for (file, name, value) in [
        (VERSION_2_FILE, "api", "s3cret ✓ value"),
        (VERSION_2_FILE, "legacy", "from v1"),
        (NODE_ENGINE_FILE, "old", "written by Node"),
    ] {
        let dir = directory();
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(owner_file(&dir, "local"), file).unwrap();
        let vault = Vault::new(dir.clone(), [9; 32], "local");
        assert_eq!(vault.get(name).await.unwrap(), value, "{name}");
        // The AAD binds version 2 entries to their owner.
        let other = Vault::new(dir.clone(), [9; 32], "other");
        std::fs::copy(owner_file(&dir, "local"), owner_file(&dir, "other")).unwrap();
        assert_eq!(other.get(name).await.is_ok(), name != "api", "{name}");
        let _ = std::fs::remove_dir_all(dir);
    }
}

#[tokio::test]
async fn reads_files_written_by_the_previous_engine() {
    // Written by the JavaScript engine: version 1 entries without AAD, upgraded on write.
    let dir = directory();
    let vault = Vault::new(dir.clone(), [9; 32], "local");
    std::fs::write(owner_file(&dir, "local"), NODE_ENGINE_FILE).unwrap();
    assert_eq!(vault.get("old").await.unwrap(), "written by Node");
    vault.put("new", "x").await.unwrap();
    let file: Value =
        serde_json::from_str(&std::fs::read_to_string(owner_file(&dir, "local")).unwrap()).unwrap();
    assert_eq!(file["version"], 2);
    assert_eq!(file["secrets"]["old"]["v"], 2);
    assert_eq!(vault.get("old").await.unwrap(), "written by Node");
    let rotated = vault.rotate([4; 32]).await.unwrap();
    assert_eq!(rotated.get("old").await.unwrap(), "written by Node");
    assert!(
        vault.get("old").await.is_err(),
        "the old key no longer decrypts"
    );
    let _ = std::fs::remove_dir_all(dir);
}
#[tokio::test]
async fn keeps_allowed_hosts_bound_to_the_secret() {
    let dir = directory();
    let vault = Vault::new(dir.clone(), [5; 32], "local");
    let hosts = vec!["api.example.com".to_string(), "*.example.org".to_string()];
    vault.put("open", "o").await.unwrap();
    vault
        .store("api", Some("s3cret"), Some(&hosts))
        .await
        .unwrap();
    // The file stays version 2; only restricted entries are version 3.
    let path = owner_file(&dir, "local");
    let file: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
    assert_eq!(file["version"], 2);
    assert_eq!(file["secrets"]["open"]["v"], 2);
    assert!(file["secrets"]["open"].get("hosts").is_none());
    assert_eq!(file["secrets"]["api"]["v"], 3);
    assert_eq!(file["secrets"]["api"]["hosts"], serde_json::json!(hosts));
    assert_eq!(vault.get("api").await.unwrap(), "s3cret");
    let listed = vault.hosts().await.unwrap();
    assert_eq!(listed["api"], hosts);
    assert!(listed["open"].is_empty());

    // A new value keeps the hosts; new hosts keep the value without typing it again.
    vault.put("api", "rotated").await.unwrap();
    assert_eq!(vault.hosts().await.unwrap()["api"], hosts);
    vault
        .store("api", None, Some(&["only.test".to_string()]))
        .await
        .unwrap();
    assert_eq!(vault.get("api").await.unwrap(), "rotated");
    assert_eq!(vault.hosts().await.unwrap()["api"], ["only.test"]);
    // No hosts allows every host again, as a version 2 entry.
    vault.store("api", None, Some(&[])).await.unwrap();
    assert!(vault.hosts().await.unwrap()["api"].is_empty());
    assert_eq!(vault.get("api").await.unwrap(), "rotated");
    assert!(vault.store("missing", None, Some(&[])).await.is_err());

    // Rotating the master key keeps them.
    vault.store("api", None, Some(&hosts)).await.unwrap();
    let rotated = vault.rotate([6; 32]).await.unwrap();
    assert_eq!(rotated.get("api").await.unwrap(), "rotated");
    assert_eq!(rotated.hosts().await.unwrap()["api"], hosts);
    let _ = std::fs::remove_dir_all(dir);
}
#[tokio::test]
async fn allowed_hosts_cannot_be_edited_in_the_file() {
    let dir = directory();
    let vault = Vault::new(dir.clone(), [8; 32], "local");
    vault
        .store(
            "api",
            Some("s3cret"),
            Some(&["api.example.com".to_string()]),
        )
        .await
        .unwrap();
    let path = owner_file(&dir, "local");
    let original = std::fs::read_to_string(&path).unwrap();
    for edit in [
        serde_json::json!(["evil.test"]),
        serde_json::json!(["api.example.com", "evil.test"]),
        serde_json::json!([]),
    ] {
        let mut file: Value = serde_json::from_str(&original).unwrap();
        file["secrets"]["api"]["hosts"] = edit.clone();
        std::fs::write(&path, file.to_string()).unwrap();
        assert!(vault.get("api").await.is_err(), "{edit}");
    }
    // Nor can a restricted entry pass as an unrestricted one.
    let mut file: Value = serde_json::from_str(&original).unwrap();
    file["secrets"]["api"]["v"] = serde_json::json!(2);
    file["secrets"]["api"]
        .as_object_mut()
        .unwrap()
        .remove("hosts");
    std::fs::write(&path, file.to_string()).unwrap();
    assert!(vault.get("api").await.is_err());
    let _ = std::fs::remove_dir_all(dir);
}
#[tokio::test]
async fn ciphertexts_are_bound_to_their_name() {
    let dir = directory();
    let vault = Vault::new(dir.clone(), [2; 32], "local");
    vault.put("a", "1").await.unwrap();
    vault.put("b", "2").await.unwrap();
    let path = owner_file(&dir, "local");
    let mut file: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
    file["secrets"]["a"] = file["secrets"]["b"].clone();
    std::fs::write(&path, file.to_string()).unwrap();
    assert!(vault.get("a").await.is_err());
    let _ = std::fs::remove_dir_all(dir);
}
