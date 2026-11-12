use super::*;
use serde_json::json;
fn fixture(id: &str, kind: DocumentKind, revision: i64) -> Document {
    Document {
        id: DocumentId::parse(id).unwrap(),
        workspace_id: WorkspaceId::parse("local").unwrap(),
        kind,
        name: "Fixture".into(),
        revision,
        updated_at: 0,
        value: json!({"item":[]}),
    }
}
fn id(value: &str) -> DocumentId {
    DocumentId::parse(value).unwrap()
}
#[tokio::test(flavor = "multi_thread")]
async fn reads_do_not_wait_for_the_writer() {
    let directory = std::env::temp_dir().join(format!("nexo-sqlite-{}", Uuid::new_v4()));
    let store = SqliteStore::open(&directory.join("nexo.sqlite")).unwrap();
    store
        .save(fixture("c1", DocumentKind::Collection, 0))
        .await
        .unwrap();
    let writer = store.connection.clone();
    let held = std::thread::spawn(move || {
        let _guard = writer.lock().unwrap();
        std::thread::sleep(std::time::Duration::from_millis(800));
    });
    std::thread::sleep(std::time::Duration::from_millis(50));
    let started = std::time::Instant::now();
    let target = id("c1");
    let reads = (0..20).map(|_| store.document(&target));
    for read in futures_util::future::join_all(reads).await {
        assert_eq!(read.unwrap().revision, 1);
    }
    assert!(started.elapsed() < std::time::Duration::from_millis(500));
    held.join().unwrap();
    drop(store);
    let _ = std::fs::remove_dir_all(directory);
}
#[tokio::test]
async fn revisions_are_atomic() {
    let store = SqliteStore::open(Path::new(":memory:")).unwrap();
    let saved = store
        .save(fixture("fixture", DocumentKind::Collection, 0))
        .await
        .unwrap();
    assert_eq!(saved.revision, 1);
    assert!(matches!(
        store
            .save(fixture("fixture", DocumentKind::Collection, 0))
            .await,
        Err(Error::Conflict)
    ));
    assert!(matches!(
        store.document(&id("missing")).await,
        Err(Error::NotFound)
    ));
    assert_eq!(store.revisions(&id("fixture")).await.unwrap().len(), 1);
}
#[tokio::test]
async fn deleted_documents_can_be_recreated_without_old_revisions() {
    let store = SqliteStore::open(Path::new(":memory:")).unwrap();
    store
        .save(fixture("again", DocumentKind::Collection, 0))
        .await
        .unwrap();
    store
        .save(fixture("again", DocumentKind::Collection, 1))
        .await
        .unwrap();
    store.delete(&id("again"), 2).await.unwrap();
    let recreated = store
        .save(fixture("again", DocumentKind::Collection, 0))
        .await
        .unwrap();
    assert_eq!(recreated.revision, 1);
    assert_eq!(store.revisions(&id("again")).await.unwrap().len(), 1);
}
#[tokio::test]
async fn summaries_omit_values_and_history_is_pruned() {
    let store = SqliteStore::open(Path::new(":memory:")).unwrap();
    let local = WorkspaceId::parse("local").unwrap();
    for index in 0..5 {
        store
            .save(fixture(&format!("h{index}"), DocumentKind::History, 0))
            .await
            .unwrap();
    }
    assert_eq!(
        store
            .summaries(&local, Some(DocumentKind::History))
            .await
            .unwrap()
            .len(),
        5
    );
    assert_eq!(
        store.prune(&local, DocumentKind::History, 2).await.unwrap(),
        3
    );
    assert_eq!(store.summaries(&local, None).await.unwrap().len(), 2);
}
#[tokio::test]
async fn workspaces_can_be_renamed_and_deleted_with_their_documents() {
    let store = SqliteStore::open(Path::new(":memory:")).unwrap();
    let other = store.create_workspace("Work").await.unwrap();
    let mut document = fixture("w1", DocumentKind::Collection, 0);
    document.workspace_id = other.id.clone();
    store.save(document).await.unwrap();
    assert_eq!(
        store.rename_workspace(&other.id, "Job").await.unwrap().name,
        "Job"
    );
    store.delete_workspace(&other.id).await.unwrap();
    assert!(matches!(
        store.document(&id("w1")).await,
        Err(Error::NotFound)
    ));
    assert_eq!(store.workspaces().await.unwrap().len(), 1);
}
#[tokio::test]
async fn multi_user_databases_migrate_to_a_single_user() {
    let directory = std::env::temp_dir().join(format!("nexo-migrate-{}", Uuid::new_v4()));
    std::fs::create_dir_all(&directory).unwrap();
    let path = directory.join("nexo.sqlite");
    {
        let mut connection = Connection::open(&path).unwrap();
        for migration in &MIGRATIONS[..2] {
            connection.execute_batch(migration).unwrap();
        }
        connection
            .execute_batch(
                "PRAGMA user_version=2;
                     INSERT INTO users VALUES('u','a@b.c','A','hash');
                     INSERT INTO workspaces VALUES('w','Team');
                     INSERT INTO members VALUES('w','u','owner');
                     INSERT INTO documents VALUES('d','w','collection','C',1,0,'{\"item\":[]}');",
            )
            .unwrap();
        let _ = &mut connection;
    }
    let store = SqliteStore::open(&path).unwrap();
    assert_eq!(store.workspaces().await.unwrap()[0].name, "Team");
    assert_eq!(store.document(&id("d")).await.unwrap().name, "C");
    let tables: i64 = store
        .with(|c| {
            c.query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE name IN ('users','members','sessions')",
                [],
                |r| r.get(0),
            )
            .map_err(err)
        })
        .await
        .unwrap();
    assert_eq!(tables, 0);
    drop(store);
    let _ = std::fs::remove_dir_all(directory);
}
