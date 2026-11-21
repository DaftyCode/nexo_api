use super::*;
use nexo_domain::native::{self, Backup, Restore, Script, Target};
use serde_json::json;
use std::time::Duration;

/// With the client tools of MariaDB (`NEXO_MARIADB_TOOLS`, their folder) and the SQL fixture
/// (`tools/sql-fixture.sh`): a backup of the fixture's database is restored into an empty one
/// with the same rows, the connection read from the private options file. Skipped without
/// them.
#[tokio::test]
async fn mariadb_backups_restore_into_an_empty_database_with_the_same_rows() {
    let (Ok(tools), Ok(host), Ok(port), Ok(password)) = (
        std::env::var("NEXO_MARIADB_TOOLS"),
        std::env::var("NEXO_SQL_MARIADB_HOST"),
        std::env::var("NEXO_SQL_MARIADB_PORT"),
        std::env::var("NEXO_SQL_MARIADB_PASSWORD"),
    ) else {
        eprintln!("skipped: set NEXO_MARIADB_TOOLS and start tools/sql-fixture.sh");
        return;
    };
    let database = std::env::var("NEXO_SQL_MARIADB_DATABASE").unwrap_or("shop".into());
    let adapter = adapter(false, vec![]);
    let target = |database: &str| Target {
        host: host.clone(),
        port: port.parse().unwrap(),
        user: Some(std::env::var("NEXO_SQL_MARIADB_USER").unwrap_or("root".into())),
        password: Some(password.clone()),
        database: Some(database.into()),
        tls: "disable".into(),
        ..Target::default()
    };
    let run = |tool: Tool, invocation: native::Invocation, path: String| {
        let adapter = &adapter;
        let tools = tools.clone();
        let password = password.clone();
        async move {
            let found = adapter.locate(Some(&tools), &[tool]).await.unwrap();
            assert!(found.version.contains("MariaDB"), "{}", found.version);
            let job = NativeJob {
                invocation,
                paths: vec![path],
                secrets: vec![password.clone()],
                timeout: Some(Duration::from_secs(120)),
            };
            let id = adapter.start(&found, job).await.unwrap();
            let done = until_done(adapter, &id).await;
            let text = done["lines"].to_string();
            assert!(!text.contains(&password), "the password is never shown");
            assert_eq!(done["state"], "finished", "{text}");
            text
        }
    };
    let sql = |database: &str, text: &str| {
        let file = std::env::temp_dir().join(format!("nexo-{}.sql", uuid::Uuid::new_v4().simple()));
        std::fs::write(&file, text).unwrap();
        let script = Script::read(&json!({"path": file.display().to_string()})).unwrap();
        (
            native::script(Tool::Mariadb, &target(database), &script, true).unwrap(),
            file.display().to_string(),
        )
    };
    let count = "SELECT CONCAT('rows=', (SELECT COUNT(*) FROM orders), '/', (SELECT COUNT(*) FROM numbers), '.') AS r;";
    let (query, file) = sql(&database, count);
    let original = run(Tool::Mariadb, query, file).await;
    let copy = format!(
        "restored_{}",
        &uuid::Uuid::new_v4().simple().to_string()[..8]
    );
    let (create, file) = sql(&database, &format!("CREATE DATABASE `{copy}`;"));
    run(Tool::Mariadb, create, file).await;
    let dump = std::env::temp_dir()
        .join(format!("nexo-{copy}.sql"))
        .display()
        .to_string();
    let backup = Backup::read(&json!({"path": dump})).unwrap();
    run(
        Tool::MariadbDump,
        native::backup(Tool::MariadbDump, &target(&database), &backup, true).unwrap(),
        dump.clone(),
    )
    .await;
    let restore = Restore::read(&json!({"path": dump})).unwrap();
    run(
        Tool::Mariadb,
        native::restore(Tool::Mariadb, &target(&copy), &restore, true).unwrap(),
        dump.clone(),
    )
    .await;
    let (query, file) = sql(&copy, count);
    let restored = run(Tool::Mariadb, query, file).await;
    let rows = |text: &str| {
        text.split("rows=")
            .nth(1)
            .and_then(|rest| rest.split_once('.').map(|(rows, _)| rows.to_string()))
    };
    assert!(
        rows(&original).is_some_and(|rows| rows.contains('/')),
        "{original}"
    );
    assert_eq!(rows(&restored), rows(&original), "{restored}");
    let _ = std::fs::remove_file(&dump);
    let (drop, file) = sql(&database, &format!("DROP DATABASE `{copy}`;"));
    run(Tool::Mariadb, drop, file).await;
}
