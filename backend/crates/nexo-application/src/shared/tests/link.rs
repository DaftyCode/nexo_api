//! A shared collection brought into a workspace with its team key, a lost file written
//! again, and what fails said.
use super::*;

#[tokio::test]
async fn a_shared_collection_is_brought_in_with_its_team_key() {
    let (application, fake) = shop();
    let key = format!("nexo-team-key-{}", "cd".repeat(32));
    let content = json!({"collection": {"info": {"name": "Team API"}, "item": [request("t1", "/t")]},
                         "environments": [{"id": "x1", "name": "Staging", "values": [{"key": "base", "value": "https://stg"}]}]});
    fake.shared.lock().unwrap().files.insert(
        "D:/Drive/Team.nexo-collection".into(),
        (content, Some(key.clone()), 7),
    );
    let link = |key: Option<&str>| {
        let mut payload = json!({"workspace": "local", "path": "D:/Drive/Team.nexo-collection"});
        if let Some(key) = key {
            payload["key"] = json!(key);
        }
        run(&application, Operation::SharedLink, payload)
    };
    assert!(
        link(None)
            .await
            .unwrap_err()
            .to_string()
            .contains("paste its team key")
    );
    assert!(link(Some("not a key")).await.is_err());
    assert!(
        link(Some(&format!("nexo-team-key-{}", "ef".repeat(32))))
            .await
            .unwrap_err()
            .to_string()
            .contains("does not open")
    );
    let linked = link(Some(&key)).await.unwrap();
    let id = linked["collection"].as_str().unwrap().to_owned();
    let documents = fake.documents.lock().unwrap().clone();
    let brought = documents.iter().find(|d| d.id.as_str() == id).unwrap();
    assert_eq!(
        (brought.name.as_str(), brought.kind),
        ("Team API", DocumentKind::Collection)
    );
    assert!(
        documents
            .iter()
            .any(|d| d.kind == DocumentKind::Environment && d.name == "Staging")
    );
    assert!(
        fake.stored
            .lock()
            .unwrap()
            .values()
            .any(|stored| stored == &key)
    );
    assert!(
        link(Some(&key))
            .await
            .unwrap_err()
            .to_string()
            .contains("already in this workspace")
    );
    assert!(
        run(
            &application,
            Operation::SharedLink,
            json!({"workspace": "local", "path": "D:/Drive/none.nexo-collection"})
        )
        .await
        .is_err()
    );
    assert!(
        run(
            &application,
            Operation::SharedLink,
            json!({"workspace": "local", "path": "D:/notes.txt"})
        )
        .await
        .is_err()
    );
    let revealed = run(
        &application,
        Operation::SharedKey,
        json!({"workspace": "local", "collection": id}),
    )
    .await
    .unwrap();
    assert_eq!(revealed["key"], key);
}

#[tokio::test]
async fn a_lost_file_is_written_again_and_what_fails_is_said() {
    let (application, fake) = shop();
    let shared = run(
        &application,
        Operation::SharedShare,
        json!({"workspace": "local", "collection": "c1", "path": PATH}),
    )
    .await
    .unwrap();
    fake.shared.lock().unwrap().files.remove(PATH);
    run(
        &application,
        Operation::SharedPoll,
        json!({"workspace": "local"}),
    )
    .await
    .unwrap();
    assert!(fake.shared_file(PATH).is_some());
    // Without its team key the link says why it cannot keep in step.
    let name = "team: Shop (c1)".to_owned();
    fake.stored.lock().unwrap().remove(&name);
    fake.missing.lock().unwrap().push(name);
    fake.teammate_writes(PATH, fake.shared_file(PATH).unwrap().0);
    let polled = run(
        &application,
        Operation::SharedPoll,
        json!({"workspace": "local"}),
    )
    .await
    .unwrap();
    assert!(
        polled["links"][0]["error"]
            .as_str()
            .unwrap()
            .contains("not in the vault")
    );
    assert!(
        run(
            &application,
            Operation::SharedSync,
            json!({"workspace": "local", "collection": "c1"})
        )
        .await
        .is_err()
    );
    assert!(shared["key"].is_string());
    // The engine's own work is not for the interface.
    let refused = run(
        &application,
        Operation::SharedWrite,
        json!({"location": {"kind": "folder", "path": PATH}, "content": {}}),
    )
    .await;
    assert!(refused.unwrap_err().to_string().contains("Nexo's own"));
    // Unlinking keeps the collection and the file; deleting the collection unlinks it.
    run(
        &application,
        Operation::SharedUnlink,
        json!({"workspace": "local", "collection": "c1"}),
    )
    .await
    .unwrap();
    assert_eq!(
        run(
            &application,
            Operation::SharedStatus,
            json!({"workspace": "local"})
        )
        .await
        .unwrap()["links"],
        json!([])
    );
    assert!(fake.shared_file(PATH).is_some());
    let other = "D:/Drive/Again.nexo-collection";
    run(
        &application,
        Operation::SharedShare,
        json!({"workspace": "local", "collection": "c1", "path": other, "encrypt": false}),
    )
    .await
    .unwrap();
    let c1 = fake
        .documents
        .lock()
        .unwrap()
        .iter()
        .find(|d| d.id.as_str() == "c1")
        .unwrap()
        .clone();
    application
        .delete_document(&c1.id, c1.revision)
        .await
        .unwrap();
    assert_eq!(
        run(
            &application,
            Operation::SharedStatus,
            json!({"workspace": "local"})
        )
        .await
        .unwrap()["links"],
        json!([])
    );
}
