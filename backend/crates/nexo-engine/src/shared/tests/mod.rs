use super::*;
use std::path::{Path, PathBuf};

mod remote;

fn folder() -> PathBuf {
    let folder = std::env::temp_dir().join(format!("nexo-shared-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&folder).unwrap();
    folder
}
fn at(file: &Path) -> Value {
    json!({"path": file.to_string_lossy()})
}
fn content(name: &str) -> Value {
    json!({"collection": {"info": {"name": name}, "item": []}, "environments": []})
}

#[test]
fn a_file_is_written_once_nobody_changed_it_and_read_back() {
    let folder = folder();
    let file = folder.join("Shop.nexo-collection");
    let location = at(&file);
    assert_eq!(
        folder::read(&json!({"location": location})).unwrap(),
        json!({"found": false})
    );
    let first = folder::write(&json!({"location": location, "content": content("Shop")})).unwrap();
    let read_back = folder::read(&json!({"location": location})).unwrap();
    assert_eq!(read_back["content"], content("Shop"));
    assert_eq!(read_back["encrypted"], false);
    assert_eq!(read_back["version"], first["version"]);
    assert_eq!(read_back["stamp"], first["stamp"]);
    // Written in the clear, it reads as JSON a person can diff.
    assert!(std::fs::read_to_string(&file).unwrap().contains("\"Shop\""));
    // Someone else's version is never written over.
    let stale = json!({"location": location, "content": content("Other"), "expected": "0"});
    assert!(matches!(folder::write(&stale), Err(Error::Conflict)));
    assert!(matches!(
        folder::write(&json!({"location": location, "content": content("New")})),
        Err(Error::Conflict)
    ));
    let next =
        json!({"location": location, "content": content("Shop 2"), "expected": first["version"]});
    let second = folder::write(&next).unwrap();
    assert_ne!(second["version"], first["version"]);
    assert!(!folder.join("Shop.nexo-collection.nexo-writing").exists());
    let stamps = stat(&json!({"paths": [file.to_string_lossy(), folder.join("gone.nexo-collection").to_string_lossy(), "C:/x.txt"]})).unwrap();
    assert_eq!(stamps["stamps"].as_object().unwrap().len(), 2);
    assert_eq!(
        stamps["stamps"][file.to_string_lossy().as_ref()],
        second["stamp"]
    );
    std::fs::remove_dir_all(folder).unwrap();
}

#[test]
fn a_sealed_file_opens_only_with_its_team_key() {
    let folder = folder();
    let file = folder.join("Team.nexo-collection");
    let location = at(&file);
    let key = new_key()["key"].as_str().unwrap().to_owned();
    folder::write(
        &json!({"location": location, "content": content("Secret name"), "resolvedKey": key}),
    )
    .unwrap();
    let raw = std::fs::read_to_string(&file).unwrap();
    assert!(!raw.contains("Secret name"), "{raw}");
    assert!(raw.contains("A256GCM"));
    let locked = folder::read(&json!({"location": location})).unwrap();
    assert_eq!(
        (locked["encrypted"].clone(), locked["locked"].clone()),
        (json!(true), json!(true))
    );
    assert!(locked.get("content").is_none());
    let opened = folder::read(&json!({"location": location, "resolvedKey": key})).unwrap();
    assert_eq!(opened["content"], content("Secret name"));
    let other = new_key()["key"].as_str().unwrap().to_owned();
    let refused = folder::read(&json!({"location": location, "resolvedKey": other})).unwrap_err();
    assert!(refused.to_string().contains("does not open"));
    assert!(folder::read(&json!({"location": location, "resolvedKey": "nope"})).is_err());
    std::fs::remove_dir_all(folder).unwrap();
}

#[test]
fn only_shared_collection_files_are_touched() {
    let folder = folder();
    let notes = folder.join("notes.txt");
    let refused =
        folder::write(&json!({"location": at(&notes), "content": content("x")})).unwrap_err();
    assert!(refused.to_string().contains(".nexo-collection"));
    assert!(!notes.exists());
    let other = folder.join("other.nexo-collection");
    std::fs::write(&other, "{\"info\": {}}").unwrap();
    assert!(
        folder::read(&json!({"location": at(&other)}))
            .unwrap_err()
            .to_string()
            .contains("not a collection")
    );
    std::fs::write(&other, "not json").unwrap();
    assert!(folder::read(&json!({"location": at(&other)})).is_err());
    let missing = folder.join("none").join("x.nexo-collection");
    let gone =
        folder::write(&json!({"location": at(&missing), "content": content("x")})).unwrap_err();
    assert!(gone.to_string().contains("folder"), "{gone}");
    assert!(
        folder::write(&json!({"location": at(&other), "content": {}, "expected": "x"})).is_err()
    );
    std::fs::remove_dir_all(folder).unwrap();
}
