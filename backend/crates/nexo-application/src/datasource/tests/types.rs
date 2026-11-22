//! The type of a connection (DB-25): the rules of one of the person's own reach its sessions.
use super::*;
use crate::testing::datasources::FakeSources;
use std::time::Duration;

fn own_type(fake: &Fake, rules: Value) {
    fake.documents.lock().unwrap().push(Document {
        id: DocumentId::parse("staging").unwrap(),
        workspace_id: WorkspaceId::parse("local").unwrap(),
        kind: DocumentKind::ConnectionType,
        name: "Staging".into(),
        revision: 1,
        updated_at: 0,
        value: rules,
    });
}

fn timeouts(sources: &FakeSources) -> Vec<Option<Duration>> {
    let executed = sources.executed.lock().unwrap();
    executed
        .iter()
        .map(|(_, request)| request.timeout)
        .collect()
}

#[tokio::test]
async fn a_type_of_your_own_confirms_changes_of_structure_and_commits_by_hand() {
    let (application, fake, sources) = with_sources(json!({"type": "staging"}));
    own_type(
        &fake,
        json!({"confirmStructure": true, "autoCommit": false, "timeoutSeconds": 30}),
    );
    connect(&application, "s1").await.unwrap();
    assert_eq!(*sources.transactions.lock().unwrap(), ["manual"]);
    // Writes run as they come; structure is confirmed first.
    run(&application, "insert into orders values (1)", json!({}))
        .await
        .unwrap();
    let error = message(run(&application, "create table t (a int)", json!({})).await);
    assert!(
        error.contains("asks to confirm changes of structure"),
        "{error}"
    );
    run(
        &application,
        "create table t (a int)",
        json!({"confirm": true}),
    )
    .await
    .unwrap();
    assert_eq!(timeouts(&sources), [Some(Duration::from_secs(30)); 2]);
}

#[tokio::test]
async fn a_read_only_type_makes_every_session_read_only() {
    let (application, fake, sources) = with_sources(json!({"type": "staging"}));
    own_type(&fake, json!({"readOnly": true, "autoCommit": true}));
    connect(&application, "s1").await.unwrap();
    assert!(sources.connected.lock().unwrap()[0].1.read_only);
    assert!(sources.transactions.lock().unwrap().is_empty());
    let error = message(run(&application, "insert into orders values (1)", json!({})).await);
    assert!(error.contains("is read-only"), "{error}");
}

#[tokio::test]
async fn a_type_that_no_longer_exists_keeps_the_connection_closed() {
    let (application, _, sources) = with_sources(json!({"type": "staging"}));
    let error = message(connect(&application, "s1").await);
    assert_eq!(
        error,
        "The type of this connection no longer exists: choose another one"
    );
    assert!(sources.connected.lock().unwrap().is_empty());
}
