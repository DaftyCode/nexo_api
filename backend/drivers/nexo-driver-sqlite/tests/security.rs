//! What keeps a SQLite connection inside the file the person chose: no `ATTACH`, `DETACH`,
//! extensions or folders named by a pragma; a read-only connection that cannot write even with
//! a pragma; and a clear error for a file that is not a database or does not exist.
mod common;

use common::{Folder, SHOP, database, driver, params, run, single};
use nexo_driver_sdk::{ErrorCode, Value};

#[tokio::test]
async fn nothing_leaves_the_chosen_file() {
    let folder = Folder::new("leave");
    let path = database(&folder, "shop.db", SHOP);
    let other = database(&folder, "other.db", "CREATE TABLE secrets (a)");
    let client = driver();
    client.connect(&params("leave", &path)).await.unwrap();
    let attach = format!("ATTACH DATABASE '{}' AS other", other.display());
    let refused = run(&client, "leave", &attach).await.unwrap_err();
    assert_eq!(refused.code, ErrorCode::Permission);
    assert!(
        refused
            .message
            .starts_with("ATTACH DATABASE is not allowed"),
        "{refused:?}"
    );
    let refused = run(&client, "leave", "DETACH DATABASE main")
        .await
        .unwrap_err();
    assert!(
        refused
            .message
            .starts_with("DETACH DATABASE is not allowed"),
        "{refused:?}"
    );
    let library = folder.file("evil");
    let load = format!("SELECT load_extension('{}')", library.display());
    let refused = run(&client, "leave", &load).await.unwrap_err();
    assert_eq!(refused.code, ErrorCode::Permission, "{refused:?}");
    assert!(
        refused.message.contains("load_extension is not allowed"),
        "{refused:?}"
    );
    let refused = run(&client, "leave", "PRAGMA temp_store_directory = '/tmp'")
        .await
        .unwrap_err();
    assert!(refused.message.contains("names a folder"), "{refused:?}");
    // A copy of the file elsewhere is a file of its own: VACUUM INTO writes nothing.
    let copy = folder.file("copy.db");
    let vacuum = format!("VACUUM INTO '{}'", copy.display());
    assert!(run(&client, "leave", &vacuum).await.is_err());
    assert!(!copy.exists());
    // The session goes on after each refusal.
    assert_eq!(
        single(&client, "leave", "SELECT count(*) FROM orders").await,
        Value::Integer(3)
    );
}

#[tokio::test]
async fn a_read_only_connection_cannot_write_even_with_a_pragma() {
    let folder = Folder::new("read");
    let path = database(&folder, "shop.db", SHOP);
    let client = driver();
    let mut read_only = params("read", &path);
    read_only.read_only = true;
    client.connect(&read_only).await.unwrap();
    let insert = "INSERT INTO customers (email) VALUES ('x@example.com')";
    let refused = run(&client, "read", insert).await.unwrap_err();
    assert_eq!(refused.code, ErrorCode::Permission, "{refused:?}");
    let refused = run(&client, "read", "PRAGMA query_only = 0")
        .await
        .unwrap_err();
    assert!(refused.message.contains("read-only"), "{refused:?}");
    assert!(run(&client, "read", insert).await.is_err());
    assert!(
        run(&client, "read", "PRAGMA journal_mode = wal")
            .await
            .is_err()
    );
    assert_eq!(
        single(&client, "read", "PRAGMA query_only").await,
        Value::Integer(1)
    );
    assert_eq!(
        single(&client, "read", "SELECT count(*) FROM customers").await,
        Value::Integer(2)
    );
}

#[tokio::test]
async fn a_file_that_is_not_a_database_or_is_missing_says_so() {
    let folder = Folder::new("files");
    let client = driver();
    let text = folder.file("notes.txt");
    std::fs::write(&text, "These are notes, not a database. ".repeat(200)).unwrap();
    let refused = client.connect(&params("text", &text)).await.unwrap_err();
    assert_eq!(refused.code, ErrorCode::Invalid);
    assert!(
        refused.message.ends_with("is not a SQLite database"),
        "{refused:?}"
    );
    let missing = folder.file("new.db");
    let refused = client.connect(&params("new", &missing)).await.unwrap_err();
    assert!(refused.message.contains("does not exist"), "{refused:?}");
    assert!(!missing.exists());
    let mut create = params("new", &missing);
    create.options.insert("create".into(), "true".into());
    create.options.insert("journal_mode".into(), "wal".into());
    client.connect(&create).await.unwrap();
    assert_eq!(
        single(&client, "new", "PRAGMA journal_mode").await,
        Value::Text("wal".into())
    );
    assert_eq!(
        single(&client, "new", "PRAGMA foreign_keys").await,
        Value::Integer(1)
    );
    assert!(missing.exists());
    let mut folder_path = params("folder", &folder.0);
    folder_path.options.insert("create".into(), "true".into());
    let refused = client.connect(&folder_path).await.unwrap_err();
    assert!(refused.message.ends_with("is not a file"), "{refused:?}");
    let mut relative = params("relative", std::path::Path::new("shop.db"));
    relative.options.insert("create".into(), "true".into());
    let refused = client.connect(&relative).await.unwrap_err();
    assert!(refused.message.contains("full path"), "{refused:?}");
    let mut unknown = params("unknown", &missing);
    unknown.options.insert("key".into(), "secret".into());
    let refused = client.connect(&unknown).await.unwrap_err();
    assert!(
        refused.message.contains("does not take the setting key"),
        "{refused:?}"
    );
}

#[tokio::test]
async fn foreign_keys_are_kept_unless_the_connection_says_otherwise() {
    let folder = Folder::new("keys");
    let path = database(&folder, "shop.db", SHOP);
    let client = driver();
    client.connect(&params("keys", &path)).await.unwrap();
    let orphan = "INSERT INTO orders (customer, status) VALUES (99, 'paid')";
    let refused = run(&client, "keys", orphan).await.unwrap_err();
    assert!(refused.message.contains("FOREIGN KEY"), "{refused:?}");
    let mut loose = params("loose", &path);
    loose.options.insert("foreign_keys".into(), "off".into());
    client.connect(&loose).await.unwrap();
    assert_eq!(
        run(&client, "loose", orphan).await.unwrap().affected,
        Some(1)
    );
}
