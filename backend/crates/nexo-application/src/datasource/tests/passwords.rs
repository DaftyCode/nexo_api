//! The password of a connection that keeps none (DB-25): asked for and kept while a session
//! of it is open, or read from the user's pgpass file.
use super::*;
use crate::ports::UserFiles;

struct Files(Option<&'static str>);
#[async_trait::async_trait]
impl UserFiles for Files {
    async fn pgpass(&self) -> Result<Option<String>> {
        Ok(self.0.map(String::from))
    }
}

async fn open(application: &Application, session: &str, password: Option<&str>) -> Result<Value> {
    let mut payload = json!({"workspace": "local", "connectionId": "c1", "session": session,
                             "variables": {"host": "db.test"}});
    if let Some(password) = password {
        payload["password"] = json!(password);
    }
    application.execute(Operation::DbConnect, payload).await
}

#[tokio::test]
async fn a_password_asked_for_lasts_while_a_session_of_its_connection_is_open() {
    let (application, _, sources) = with_sources(json!({"password": null, "askPassword": true}));
    let Error::Database { code, detail, .. } = open(&application, "s1", None).await.unwrap_err()
    else {
        panic!("not a database error");
    };
    assert_eq!(code, "password");
    assert_eq!(detail.unwrap()["connection"], "Shop");
    let opened = open(&application, "s1", Some("typed-pw")).await.unwrap();
    assert!(!opened.to_string().contains("typed-pw"));
    // Another session of the connection needs no password while the first is open.
    open(&application, "s2", None).await.unwrap();
    let passwords: Vec<_> = sources
        .connected
        .lock()
        .unwrap()
        .iter()
        .map(|(_, connection)| connection.password.clone().unwrap_or_default())
        .collect();
    assert_eq!(passwords, ["typed-pw", "typed-pw"]);
    // A statement that fails with it never says it.
    let error = message(run(&application, "SELECT fail", json!({})).await);
    assert!(!error.contains("typed-pw"), "{error}");
    for session in ["s1", "s2"] {
        application
            .execute(Operation::DbDisconnect, json!({"session": session}))
            .await
            .unwrap();
    }
    // With every session closed, it is asked for again.
    assert!(open(&application, "s3", None).await.is_err());
    // A test of the connection takes the password typed in the form.
    let tested = application
        .execute(
            Operation::DbTest,
            json!({"workspace": "local", "connectionId": "c1", "variables": {"host": "db.test"},
                   "password": "form-pw"}),
        )
        .await
        .unwrap();
    assert_eq!(tested["server"]["note"], "[redacted]");
}

#[tokio::test]
async fn a_connection_reads_its_password_from_pgpass_only_when_it_says_so() {
    let (application, _, sources) = with_sources(json!({"password": null, "pgpass": true}));
    let application = application.with_user_files(Arc::new(Files(Some(
        "other:5432:shop:ana:wrong
db.test:5432:shop:ana:from-file
",
    ))));
    connect(&application, "s1").await.unwrap();
    let (_, connection) = sources.connected.lock().unwrap()[0].clone();
    assert_eq!(connection.password.as_deref(), Some("from-file"));

    let (application, _, _) = with_sources(json!({"password": null, "pgpass": true}));
    let none = application.with_user_files(Arc::new(Files(Some(
        "other:*:*:*:x
",
    ))));
    let error = message(connect(&none, "s1").await);
    assert_eq!(
        error,
        "The pgpass file has no line for db.test:5432, database shop as ana"
    );
    let (application, _, _) = with_sources(json!({"password": null, "pgpass": true}));
    let missing = application.with_user_files(Arc::new(Files(None)));
    assert_eq!(
        message(connect(&missing, "s1").await),
        "There is no pgpass file for this user"
    );
}
