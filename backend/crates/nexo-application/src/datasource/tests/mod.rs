//! The databases of the modules: sessions, their rules, the history and what never leaves.
use crate::testing::{datasources::with_sources, *};

mod rules;

async fn connect(application: &Application, session: &str) -> Result<Value> {
    application
        .execute(
            Operation::DbConnect,
            json!({"workspace": "local", "connectionId": "c1", "session": session,
                   "variables": {"host": "db.test"}}),
        )
        .await
}
async fn run(application: &Application, sql: &str, extra: Value) -> Result<Value> {
    let mut payload = json!({"session": "s1", "statement": "q1", "sql": sql});
    if let (Value::Object(payload), Value::Object(extra)) = (&mut payload, extra) {
        payload.extend(extra);
    }
    application.execute(Operation::DbExecute, payload).await
}
fn message(result: Result<Value>) -> String {
    result.unwrap_err().to_string()
}

#[tokio::test]
async fn a_session_opens_the_saved_connection_with_its_variables_and_secrets() {
    let (application, _, sources) = with_sources(json!({}));
    assert_eq!(
        connect(&application, "s1").await.unwrap()["serverVersion"],
        "16.4"
    );
    let (session, connection) = sources.connected.lock().unwrap()[0].clone();
    assert_eq!(session, "s1");
    assert_eq!(connection.host.as_deref(), Some("db.test"));
    assert_eq!(connection.port, Some(5432));
    // The fake vault answers `secret-of-<name>`.
    assert_eq!(
        connection.password.as_deref(),
        Some("secret-of-db-password:c1")
    );
    assert!(!format!("{connection:?}").contains("secret-of"));

    let missing = application
        .execute(
            Operation::DbConnect,
            json!({"workspace": "local", "connectionId": "c1", "session": "s2"}),
        )
        .await;
    assert_eq!(
        message(missing),
        "The variable {{host}} has no value in the active environment"
    );
    for (payload, expected) in [
        (
            json!({"workspace": "local", "connectionId": "nope", "session": "s3"}),
            "not found",
        ),
        (
            json!({"workspace": "local", "connectionId": "c1", "session": "a b"}),
            "Invalid session name",
        ),
        (
            json!({"connectionId": "c1", "session": "s3"}),
            "Choose a workspace",
        ),
    ] {
        let error = message(application.execute(Operation::DbConnect, payload).await);
        assert!(error.contains(expected), "{error}");
    }
}

#[tokio::test]
async fn the_password_never_comes_back_in_an_answer_or_an_error() {
    let (application, fake, _) = with_sources(json!({}));
    connect(&application, "s1").await.unwrap();
    let error = run(&application, "select fail", json!({}))
        .await
        .unwrap_err();
    match &error {
        Error::Database {
            code,
            message,
            detail,
        } => {
            assert_eq!(code, "syntax");
            assert_eq!(message, "near fail (password [redacted])");
            assert_eq!(detail, &Some(json!({"position": 8})));
        }
        other => panic!("not a database error: {other:?}"),
    }
    let tested = application
        .execute(
            Operation::DbTest,
            json!({"workspace": "local", "connectionId": "c1", "variables": {"host": "db.test"}}),
        )
        .await
        .unwrap();
    assert_eq!(tested["server"]["note"], "[redacted]");
    // Refused at connection, with the password in the driver's message.
    let (down, _, _) = with_sources(json!({"host": "down.test"}));
    let refused = message(connect(&down, "s1").await);
    assert_eq!(refused, "password [redacted] refused");
    // The history keeps the failure, without the password either.
    let history = fake.documents.lock().unwrap();
    let failed = history
        .iter()
        .find(|d| d.kind == DocumentKind::SqlHistory)
        .unwrap();
    assert_eq!(failed.value["error"], "near fail (password [redacted])");
}

#[tokio::test]
async fn statements_name_an_open_session_and_are_recorded() {
    let (application, fake, sources) = with_sources(json!({"timeoutSeconds": 30}));
    let closed = message(run(&application, "select 1", json!({})).await);
    assert_eq!(closed, "The session is not open: connect first");
    connect(&application, "s1").await.unwrap();
    let answer = run(
        &application,
        "select n\nfrom numbers",
        json!({"pageRows": 50, "params": [1]}),
    )
    .await
    .unwrap();
    assert_eq!(answer["rows"], json!([[1], [2]]));
    let (_, request) = sources.executed.lock().unwrap()[0].clone();
    assert_eq!(
        (request.statement.as_str(), request.page_rows),
        ("q1", Some(50))
    );
    assert_eq!(request.params, [json!(1)]);
    assert_eq!(request.timeout, Some(std::time::Duration::from_secs(30)));

    let recorded: Vec<Document> = fake
        .documents
        .lock()
        .unwrap()
        .iter()
        .filter(|d| d.kind == DocumentKind::SqlHistory)
        .cloned()
        .collect();
    assert_eq!(recorded.len(), 1);
    assert_eq!(recorded[0].name, "select n…");
    assert_eq!(recorded[0].value["sql"], "select n\nfrom numbers");
    assert_eq!(recorded[0].value["rows"], 2);
    assert_eq!(recorded[0].value["connection"], "Shop");
    assert!(
        fake.pruned
            .lock()
            .unwrap()
            .contains(&crate::SQL_HISTORY_LIMIT)
    );

    let tree = application
        .execute(
            Operation::DbTree,
            json!({"session": "s1", "path": ["shop", "public"]}),
        )
        .await
        .unwrap();
    assert_eq!(tree["nodes"][0]["name"], "2");
    let page = application
        .execute(Operation::DbFetch, json!({"session": "s1", "cursor": "c9"}))
        .await
        .unwrap();
    assert_eq!(page["from"], "c9");
    let state = application
        .execute(
            Operation::DbTransaction,
            json!({"session": "s1", "action": "begin"}),
        )
        .await
        .unwrap();
    assert_eq!(state["open"], true);
    let unknown = application
        .execute(
            Operation::DbTransaction,
            json!({"session": "s1", "action": "explode"}),
        )
        .await;
    assert!(message(unknown).contains("Unknown transaction action"));

    application
        .execute(Operation::DbDisconnect, json!({"session": "s1"}))
        .await
        .unwrap();
    assert_eq!(*sources.disconnected.lock().unwrap(), ["s1"]);
    assert_eq!(
        message(run(&application, "select 1", json!({})).await),
        "The session is not open: connect first"
    );
}

#[tokio::test]
async fn a_connection_being_written_is_tested_only_with_its_secrets_in_the_vault() {
    let (application, _, _) = with_sources(json!({}));
    let typed = application
        .execute(
            Operation::DbTest,
            json!({"connection": {"driver": "postgres", "host": "h", "password": "hunter2"}}),
        )
        .await;
    assert!(message(typed).contains("Keep the password out of the connection"));
    let tested = application
        .execute(
            Operation::DbTest,
            json!({"connection": {"driver": "postgres", "host": "h", "user": "ana"}}),
        )
        .await
        .unwrap();
    assert_eq!(tested["server"]["user"], "ana");
}

#[tokio::test]
async fn scripts_are_split_with_what_each_statement_does() {
    let (application, _, _) = with_sources(json!({}));
    let script = "select 1;\ndelete from orders;\ndrop table t;";
    let answer = application
        .execute(
            Operation::DbSplit,
            json!({"script": script, "dialect": "postgresql", "offset": 12}),
        )
        .await
        .unwrap();
    let statements = answer["statements"].as_array().unwrap();
    assert_eq!(statements.len(), 3);
    assert_eq!(answer["current"], 1);
    assert_eq!(statements[1]["text"], "delete from orders");
    assert_eq!(statements[1]["classification"]["missingWhere"], true);
    assert_eq!(statements[2]["classification"]["drop"], json!(["t"]));
    assert_eq!(statements[0]["classification"]["kind"], "read");
}
