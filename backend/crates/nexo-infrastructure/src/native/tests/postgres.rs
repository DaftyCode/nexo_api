use super::*;
use nexo_domain::native::{self, Backup, Restore, Target};
use serde_json::json;
use std::time::Duration;

/// With the client tools of PostgreSQL (`NEXO_PG_TOOLS`, their folder) and the SQL fixture
/// (`tools/sql-fixture.sh`): a backup in plain SQL and another in the custom format are
/// restored into empty databases with the same rows. Skipped without them.
#[tokio::test]
async fn postgres_backups_restore_into_an_empty_database_with_the_same_rows() {
    let (Ok(tools), Ok(host), Ok(port), Ok(password)) = (
        std::env::var("NEXO_PG_TOOLS"),
        std::env::var("NEXO_SQL_PG_HOST"),
        std::env::var("NEXO_SQL_PG_PORT"),
        std::env::var("NEXO_SQL_PG_PASSWORD"),
    ) else {
        eprintln!("skipped: set NEXO_PG_TOOLS and start tools/sql-fixture.sh");
        return;
    };
    let user = std::env::var("NEXO_SQL_PG_USER").unwrap_or("nexo".into());
    let database = std::env::var("NEXO_SQL_PG_DATABASE").unwrap_or("shop".into());
    let adapter = adapter(false, vec![]);
    let target = |database: &str| Target {
        host: host.clone(),
        port: port.parse().unwrap(),
        user: Some(user.clone()),
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
    let psql = |database: &str, sql: &str| {
        let file = std::env::temp_dir().join(format!("nexo-{}.sql", uuid::Uuid::new_v4().simple()));
        std::fs::write(&file, sql).unwrap();
        let script = native::Script::read(&json!({"path": file.display().to_string()})).unwrap();
        (
            native::script(Tool::Psql, &target(database), &script, false).unwrap(),
            file.display().to_string(),
        )
    };
    let count = "SELECT 'rows=' || (SELECT count(*) FROM shop.orders) || '/' || (SELECT count(*) FROM public.numbers) || '/' || (SELECT sum(total) FROM shop.orders) || '.';";
    let (query, file) = psql(&database, count);
    let original = run(Tool::Psql, query, file).await;
    let suffix = uuid::Uuid::new_v4().simple().to_string();
    for (format, tool) in [("plain", Tool::Psql), ("custom", Tool::PgRestore)] {
        let copy = format!("restored_{format}_{}", &suffix[..8]);
        let (create, file) = psql(&database, &format!("CREATE DATABASE \"{copy}\";"));
        run(Tool::Psql, create, file).await;
        let dump = std::env::temp_dir()
            .join(format!("nexo-{copy}.dump"))
            .display()
            .to_string();
        let backup =
            Backup::read(&json!({"path": dump, "format": format, "noOwner": true})).unwrap();
        run(
            Tool::PgDump,
            native::backup(Tool::PgDump, &target(&database), &backup, false).unwrap(),
            dump.clone(),
        )
        .await;
        let restore =
            Restore::read(&json!({"path": dump, "format": format, "singleTransaction": true}))
                .unwrap();
        run(
            tool,
            native::restore(tool, &target(&copy), &restore, false).unwrap(),
            dump.clone(),
        )
        .await;
        let (query, file) = psql(&copy, count);
        let restored = run(Tool::Psql, query, file).await;
        let rows = |text: &str| {
            text.split("rows=")
                .nth(1)
                .and_then(|rest| rest.split_once(".\"").map(|(rows, _)| rows.to_string()))
        };
        assert!(
            rows(&original).is_some_and(|rows| rows.contains("/100000/")),
            "{original}"
        );
        assert_eq!(rows(&restored), rows(&original), "{format}: {restored}");
        // A table whose name has spaces and dashes is backed up by its exact name.
        let (odd, file) = psql(
            &copy,
            "CREATE TABLE public.\"odd name-1\" (id int); INSERT INTO public.\"odd name-1\" VALUES (7);",
        );
        run(Tool::Psql, odd, file).await;
        let only = std::env::temp_dir()
            .join(format!("nexo-{copy}-odd.sql"))
            .display()
            .to_string();
        let backup = Backup::read(
            &json!({"path": only, "tables": [{"schema": "public", "name": "odd name-1"}]}),
        )
        .unwrap();
        run(
            Tool::PgDump,
            native::backup(Tool::PgDump, &target(&copy), &backup, false).unwrap(),
            only.clone(),
        )
        .await;
        let written = std::fs::read_to_string(&only).unwrap();
        assert!(
            written.contains("CREATE TABLE public.\"odd name-1\""),
            "{written}"
        );
        assert!(!written.contains("numbers"), "only that table");
        let _ = std::fs::remove_file(&only);
        let _ = std::fs::remove_file(&dump);
        let (drop, file) = psql(&database, &format!("DROP DATABASE \"{copy}\";"));
        run(Tool::Psql, drop, file).await;
    }
}
