//! The adapter of the local client tools: its pure parts, a fake tool on Unix and, with the
//! real tools and the SQL fixture, PostgreSQL and MariaDB backups restored (`postgres.rs`, `mariadb.rs`).
mod mariadb;
mod postgres;

use super::*;
#[cfg(unix)]
use nexo_domain::native::{self, Backup, Target};
#[cfg(unix)]
use serde_json::json;
use std::{net::SocketAddr, time::Duration};

#[derive(Default)]
struct Policy {
    strict: bool,
    checked: Mutex<Vec<(String, u16)>>,
}
#[async_trait]
impl NetworkPolicy for Policy {
    async fn check_destination(&self, host: &str, port: u16) -> Result<()> {
        self.checked.lock().unwrap().push((host.into(), port));
        if host == "blocked.test" {
            return Err(Error::Validation(format!("Destination {host} is blocked")));
        }
        Ok(())
    }
    async fn resolve_destination(&self, _host: &str, port: u16) -> Result<Vec<SocketAddr>> {
        Ok(vec![SocketAddr::from(([10, 0, 0, 7], port))])
    }
    fn restrictive(&self) -> bool {
        self.strict
    }
}

pub(super) fn adapter(strict: bool, protected: Vec<PathBuf>) -> NativeAdapter {
    NativeAdapter::new(
        Arc::new(Policy {
            strict,
            ..Policy::default()
        }),
        protected,
    )
}

pub(super) async fn until_done(adapter: &NativeAdapter, id: &str) -> Value {
    for _ in 0..600 {
        let status = adapter.status(id).await.unwrap();
        if status["state"] != "running" {
            return status;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    panic!("the run did not end");
}

#[test]
fn the_private_folder_replaces_its_mark_and_nexo_data_is_protected() {
    let temp = Path::new("C:\\Users\\ana\\Temp\\nexo-native-1");
    assert_eq!(
        placed(&format!("--defaults-extra-file={TEMP}/client.cnf"), temp),
        "--defaults-extra-file=C:/Users/ana/Temp/nexo-native-1/client.cnf"
    );
    let data = std::env::temp_dir().join(format!("nexo-data-{}", uuid::Uuid::new_v4().simple()));
    std::fs::create_dir_all(data.join("projects")).unwrap();
    assert!(inside(
        &data.join("nexo.sqlite"),
        std::slice::from_ref(&data)
    ));
    assert!(inside(
        &data.join("projects").join("..").join("x.sql"),
        std::slice::from_ref(&data)
    ));
    assert!(!inside(
        &std::env::temp_dir().join("backup.sql"),
        std::slice::from_ref(&data)
    ));
    std::fs::remove_dir_all(&data).unwrap();
}

#[test]
fn a_run_keeps_its_last_lines_without_secrets() {
    let job = Job::new("pg_dump", vec!["s3cret".into(), "ab".into()]);
    for line in 0..2005 {
        job.push(&format!("line {line} with s3cret and ab"));
    }
    job.finish("finished", Some(0));
    let status = job.status();
    assert_eq!(status["dropped"], 5);
    assert_eq!(status["lines"][0], "line 5 with **** and ab");
    assert_eq!(status["state"], "finished");
    assert_eq!(status["exitCode"], 0);
}

#[tokio::test]
async fn tools_are_found_only_by_their_exact_name_and_servers_pass_the_egress_policy() {
    let empty = std::env::temp_dir().join(format!("nexo-tools-{}", uuid::Uuid::new_v4().simple()));
    std::fs::create_dir_all(&empty).unwrap();
    let folder = empty.display().to_string();
    let error = locate::find(Some(&folder), &[Tool::PgDump]).unwrap_err();
    assert!(
        error
            .to_string()
            .contains("pg_dump is not in the local client folder")
    );
    let error = locate::find(Some("relative/bin"), &[Tool::PgDump]).unwrap_err();
    assert!(error.to_string().contains("does not exist"));
    std::fs::remove_dir_all(&empty).unwrap();
    assert!(
        adapter(false, vec![])
            .destination("db.test", 5432)
            .await
            .unwrap()
            .is_none()
    );
    assert!(
        adapter(false, vec![])
            .destination("blocked.test", 5432)
            .await
            .is_err()
    );
    assert_eq!(
        adapter(true, vec![])
            .destination("db.test", 5432)
            .await
            .unwrap()
            .as_deref(),
        Some("10.0.0.7")
    );
}

/// A tool that prints its version, its arguments and whether it got a password.
#[cfg(unix)]
fn fake_tool(folder: &Path, name: &str) -> LocatedTool {
    use std::os::unix::fs::PermissionsExt;
    let path = folder.join(name);
    std::fs::write(
        &path,
        "#!/bin/sh\nif [ \"$1\" = --version ]; then echo \"$0 (PostgreSQL) 18.1\"; exit 0; fi\n\
         echo \"args: $*\"; echo \"password $PGPASSWORD\"; echo \"leaked ${PGSERVICEFILE:-none}\"\n\
         [ -n \"$SLEEP\" ] && sleep 30\nexit 3\n",
    )
    .unwrap();
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
    LocatedTool {
        tool: Tool::parse(name).unwrap(),
        path: path.display().to_string(),
        version: String::new(),
    }
}

#[cfg(unix)]
#[tokio::test]
async fn a_run_is_followed_redacted_cancelled_and_leaves_no_temporary_files() {
    let folder = std::env::temp_dir().join(format!("nexo-fake-{}", uuid::Uuid::new_v4().simple()));
    std::fs::create_dir_all(&folder).unwrap();
    let tool = fake_tool(&folder, "pg_dump");
    let adapter = adapter(false, vec![folder.join("data")]);
    let found = adapter
        .locate(Some(&folder.display().to_string()), &[Tool::PgDump])
        .await
        .unwrap();
    assert!(found.version.ends_with("(PostgreSQL) 18.1"));
    let target = Target {
        host: "db.test".into(),
        port: 5432,
        password: Some("s3cret".into()),
        database: Some("shop".into()),
        tls: "disable".into(),
        ..Target::default()
    };
    let backup =
        Backup::read(&json!({"path": folder.join("out.sql").display().to_string()})).unwrap();
    let invocation = native::backup(Tool::PgDump, &target, &backup, false).unwrap();
    let job = NativeJob {
        invocation: invocation.clone(),
        paths: vec![backup.path.clone()],
        secrets: vec!["s3cret".into()],
        timeout: None,
    };
    let id = adapter.start(&tool, job).await.unwrap();
    let done = until_done(&adapter, &id).await;
    assert_eq!(
        (done["state"].clone(), done["exitCode"].clone()),
        (json!("failed"), json!(3))
    );
    let lines: Vec<&str> = done["lines"]
        .as_array()
        .unwrap()
        .iter()
        .map(|l| l.as_str().unwrap())
        .collect();
    assert!(lines.contains(&"password ****"), "{lines:?}");
    assert!(lines.contains(&"leaked none"));
    let leftovers = std::fs::read_dir(std::env::temp_dir())
        .unwrap()
        .flatten()
        .filter(|e| e.file_name().to_string_lossy().starts_with("nexo-native-"))
        .count();
    assert_eq!(leftovers, 0, "the private folder is deleted");
    // Nexo's own data is never a destination, and a long run can be cancelled.
    let inside =
        Backup::read(&json!({"path": folder.join("data").join("x.sql").display().to_string()}))
            .unwrap();
    let job = NativeJob {
        invocation: native::backup(Tool::PgDump, &target, &inside, false).unwrap(),
        paths: vec![inside.path.clone()],
        secrets: vec![],
        timeout: None,
    };
    assert!(
        adapter
            .start(&tool, job)
            .await
            .unwrap_err()
            .to_string()
            .contains("outside Nexo")
    );
    let mut slow = invocation;
    slow.env.push(("SLEEP".into(), "1".into()));
    let job = NativeJob {
        invocation: slow,
        paths: vec![],
        secrets: vec![],
        timeout: None,
    };
    let id = adapter.start(&tool, job).await.unwrap();
    adapter.cancel(&id).await.unwrap();
    assert_eq!(until_done(&adapter, &id).await["state"], "cancelled");
    std::fs::remove_dir_all(&folder).unwrap();
}
