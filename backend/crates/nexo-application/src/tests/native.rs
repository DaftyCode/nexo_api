//! Backups, restores and scripts with the local client tools: the rules before anything
//! runs, and what reaches the adapter.
use crate::ports::{LocatedTool, NativeJob, NativeTools};
use crate::testing::*;
use async_trait::async_trait;
use nexo_domain::native::Tool;

#[derive(Default)]
struct Tools {
    started: Mutex<Vec<(LocatedTool, NativeJob)>>,
    folders: Mutex<Vec<Option<String>>>,
}

#[async_trait]
impl NativeTools for Tools {
    async fn locate(&self, folder: Option<&str>, tools: &[Tool]) -> Result<LocatedTool> {
        self.folders.lock().unwrap().push(folder.map(String::from));
        Ok(LocatedTool {
            tool: tools[0],
            path: format!("/opt/pg/bin/{}", tools[0].name()),
            version: format!("{} (PostgreSQL) 18.1", tools[0].name()),
        })
    }
    async fn destination(&self, host: &str, _port: u16) -> Result<Option<String>> {
        if host == "blocked.test" {
            return Err(Error::Validation(
                "Destination blocked.test is blocked".into(),
            ));
        }
        Ok(None)
    }
    async fn start(&self, tool: &LocatedTool, job: NativeJob) -> Result<String> {
        self.started.lock().unwrap().push((tool.clone(), job));
        Ok("run-1".into())
    }
    async fn status(&self, id: &str) -> Result<Value> {
        Ok(json!({"id": id, "state": "finished"}))
    }
    async fn cancel(&self, _id: &str) -> Result<()> {
        Ok(())
    }
}

fn file(name: &str) -> String {
    std::env::temp_dir().join(name).display().to_string()
}

fn with_connection(fake: &Fake, value: Value) {
    fake.documents.lock().unwrap().push(Document {
        id: DocumentId::parse("c1").unwrap(),
        workspace_id: WorkspaceId::parse("local").unwrap(),
        kind: DocumentKind::Connection,
        name: "Shop".into(),
        revision: 1,
        updated_at: 1,
        value,
    });
}

fn setup(value: Value) -> (Application, Arc<Tools>) {
    let (application, fake) = application();
    with_connection(&fake, value);
    let tools = Arc::new(Tools::default());
    (application.with_native_tools(tools.clone()), tools)
}

fn postgres() -> Value {
    json!({"driver": "postgres", "host": "db.test", "port": 5432, "database": "shop", "user": "ana",
           "password": "{{vault:db-password:c1}}", "localClient": "/opt/pg/bin"})
}

async fn run(application: &Application, operation: Operation, payload: Value) -> Result<Value> {
    let mut payload = payload;
    payload["workspace"] = json!("local");
    payload["connection"] = json!("c1");
    application.execute(operation, payload).await
}

#[tokio::test]
async fn the_client_tools_do_not_go_through_a_route() {
    let mut value = postgres();
    value["route"] = json!({"via": "socks5", "host": "proxy.test"});
    let (application, tools) = setup(value);
    let options = json!({"options": {"path": file("shop.dump"), "format": "custom"}});
    let refused = run(&application, Operation::NativeBackup, options)
        .await
        .unwrap_err();
    assert!(
        refused
            .to_string()
            .contains("SOCKS5 proxy or an SSH tunnel"),
        "{refused}"
    );
    assert!(tools.started.lock().unwrap().is_empty());
}

#[tokio::test]
async fn a_backup_runs_the_tool_of_the_connection_folder_with_its_password_kept_out() {
    let (application, tools) = setup(postgres());
    let started = run(
        &application,
        Operation::NativeBackup,
        json!({"options": {"path": file("shop.dump"), "format": "custom"}, "timeoutSeconds": 60}),
    )
    .await
    .unwrap();
    assert_eq!(
        started,
        json!({"id": "run-1", "tool": "pg_dump", "version": "pg_dump (PostgreSQL) 18.1"})
    );
    let (tool, job) = tools.started.lock().unwrap().pop().unwrap();
    assert_eq!(tool.tool, Tool::PgDump);
    assert_eq!(
        tools.folders.lock().unwrap()[0].as_deref(),
        Some("/opt/pg/bin")
    );
    assert_eq!(job.paths, [file("shop.dump")]);
    assert_eq!(job.timeout, Some(std::time::Duration::from_secs(60)));
    assert!(
        job.secrets
            .contains(&"secret-of-db-password:c1".to_string())
    );
    assert!(
        job.invocation
            .args
            .iter()
            .all(|arg| !arg.contains("secret-of"))
    );
    assert!(
        job.invocation
            .env
            .contains(&("PGPASSWORD".into(), "secret-of-db-password:c1".into()))
    );
    // The tool a connection would use, and how a run goes.
    let found = run(
        &application,
        Operation::NativeLocate,
        json!({"need": "archive"}),
    )
    .await
    .unwrap();
    assert_eq!(found["tool"], "pg_restore");
    let status = application
        .execute(Operation::NativeStatus, json!({"id": "run-1"}))
        .await
        .unwrap();
    assert_eq!(status["state"], "finished");
    let cancelled = application
        .execute(Operation::NativeCancel, json!({"id": "run-1"}))
        .await
        .unwrap();
    assert_eq!(cancelled, json!({"cancelled": true}));
}

#[tokio::test]
async fn a_restore_needs_the_database_typed_and_production_a_confirmation() {
    let mut production = postgres();
    production["type"] = json!("production");
    let (application, tools) = setup(production);
    let restore = json!({"path": file("shop.sql")});
    let refused = run(
        &application,
        Operation::NativeRestore,
        json!({"options": restore, "database": "copy", "confirm": true}),
    )
    .await;
    assert!(
        refused
            .unwrap_err()
            .to_string()
            .contains("Type the name of the database")
    );
    let refused = run(
        &application,
        Operation::NativeRestore,
        json!({"options": restore, "database": "copy", "confirmName": "copy"}),
    )
    .await;
    assert!(
        refused
            .unwrap_err()
            .to_string()
            .contains("is for production")
    );
    let script = run(
        &application,
        Operation::NativeScript,
        json!({"options": {"path": file("big.sql")}}),
    )
    .await;
    assert!(
        script
            .unwrap_err()
            .to_string()
            .contains("is for production")
    );
    assert!(tools.started.lock().unwrap().is_empty());
    run(
        &application,
        Operation::NativeRestore,
        json!({"options": restore, "database": "copy", "confirmName": "copy", "confirm": true}),
    )
    .await
    .unwrap();
    let (tool, job) = tools.started.lock().unwrap().pop().unwrap();
    assert_eq!(tool.tool, Tool::Psql);
    assert!(
        job.invocation
            .args
            .contains(&"--dbname=dbname='copy'".to_string())
    );
}

#[tokio::test]
async fn read_only_connections_restore_nothing_and_other_engines_or_the_web_have_no_tools() {
    let mut read_only = postgres();
    read_only["readOnly"] = json!(true);
    let (application, _) = setup(read_only);
    let refused = run(
        &application,
        Operation::NativeScript,
        json!({"options": {"path": file("a.sql")}}),
    )
    .await;
    assert!(refused.unwrap_err().to_string().contains("is read-only"));
    // A read-only connection still backs up.
    run(
        &application,
        Operation::NativeBackup,
        json!({"options": {"path": file("a.sql")}}),
    )
    .await
    .unwrap();

    let mut certificate = postgres();
    certificate["tls"] =
        json!({"mode": "verify", "certPem": "PEM", "keyPem": "{{vault:db-key:c1}}"});
    let (application, _) = setup(certificate);
    let refused = run(
        &application,
        Operation::NativeBackup,
        json!({"options": {"path": file("a.sql")}}),
    )
    .await;
    assert!(
        refused
            .unwrap_err()
            .to_string()
            .contains("client certificate")
    );

    let mut blocked = postgres();
    blocked["host"] = json!("blocked.test");
    let (application, _) = setup(blocked);
    let refused = run(
        &application,
        Operation::NativeBackup,
        json!({"options": {"path": file("a.sql")}}),
    )
    .await;
    assert!(refused.unwrap_err().to_string().contains("blocked"));

    let (application, _) = setup(json!({"driver": "sqlite", "database": file("x.db")}));
    let refused = run(
        &application,
        Operation::NativeBackup,
        json!({"options": {"path": file("a.sql")}}),
    )
    .await;
    assert!(
        refused
            .unwrap_err()
            .to_string()
            .contains("PostgreSQL, MySQL and MariaDB")
    );

    let (web, fake) = crate::testing::application();
    with_connection(&fake, postgres());
    let refused = run(
        &web,
        Operation::NativeBackup,
        json!({"options": {"path": file("a.sql")}}),
    )
    .await;
    assert!(
        refused
            .unwrap_err()
            .to_string()
            .contains("in the desktop app")
    );
    let refused = web
        .execute(Operation::NativeStatus, json!({"id": "run-1"}))
        .await;
    assert!(
        refused
            .unwrap_err()
            .to_string()
            .contains("in the desktop app")
    );
}
