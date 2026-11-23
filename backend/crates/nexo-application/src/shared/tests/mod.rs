//! A collection shared by the team: written masked and sealed, kept in step after every save
//! and when a teammate's change reaches the file, what both changed asked and resolved, and
//! brought into another workspace with its team key.
use crate::testing::*;

pub(super) const PATH: &str = "D:/Drive/Shop.nexo-collection";

pub(super) fn document(id: &str, kind: DocumentKind, name: &str, value: Value) -> Document {
    Document {
        id: DocumentId::parse(id).unwrap(),
        workspace_id: WorkspaceId::parse("local").unwrap(),
        kind,
        name: name.into(),
        revision: 1,
        updated_at: 0,
        value,
    }
}

pub(super) fn request(id: &str, url: &str) -> Value {
    json!({"id": id, "name": id, "request": {"method": "GET", "url": url,
           "auth": {"type": "bearer", "bearer": [{"key": "token", "value": "my-own-token"}]}}})
}

/// A workspace with the collection Shop (its first request without an id) and Dev.
pub(super) fn shop() -> (Application, Arc<Fake>) {
    let (application, fake) = application();
    let items = json!([{"name": "List", "request": {"method": "GET", "url": "/list"}}, request("r1", "/a")]);
    fake.documents.lock().unwrap().extend([
        document(
            "c1",
            DocumentKind::Collection,
            "Shop",
            json!({"info": {"name": "Shop"}, "item": items, "nexoTransport": "t1"}),
        ),
        document(
            "e1",
            DocumentKind::Environment,
            "Dev",
            json!({"name": "Dev", "values": [
            {"key": "base", "value": "https://dev", "enabled": true},
            {"key": "password", "value": "hunter2", "enabled": true, "type": "secret"}]}),
        ),
    ]);
    (application, fake)
}

pub(super) async fn run(
    application: &Application,
    operation: Operation,
    payload: Value,
) -> Result<Value> {
    application.execute(operation, payload).await
}

pub(super) fn collection(fake: &Fake) -> Value {
    let documents = fake.documents.lock().unwrap();
    documents
        .iter()
        .find(|d| d.id.as_str() == "c1")
        .unwrap()
        .value
        .clone()
}

mod conflicts;
mod link;
mod remote;

#[tokio::test]
async fn a_collection_is_shared_masked_sealed_and_kept_in_step() {
    let (application, fake) = shop();
    let shared = run(
        &application,
        Operation::SharedShare,
        json!({"workspace": "local", "collection": "c1", "path": PATH, "environments": ["e1"]}),
    )
    .await
    .unwrap();
    let key = shared["key"].as_str().unwrap().to_owned();
    assert!(key.starts_with("nexo-team-key-"));
    assert_eq!(
        fake.stored.lock().unwrap().get("team: Shop (c1)"),
        Some(&key)
    );
    let (content, sealed, _) = fake.shared_file(PATH).unwrap();
    assert_eq!(sealed.as_deref(), Some(key.as_str()));
    let text = content.to_string();
    for secret in ["my-own-token", "hunter2", "nexoTransport"] {
        assert!(!text.contains(secret), "{secret} in {text}");
    }
    assert!(text.contains("https://dev"));
    // Every item has an id now, here and in the file.
    assert!(
        collection(&fake)["item"][0]["id"]
            .as_str()
            .is_some_and(|id| !id.is_empty())
    );
    let status = run(
        &application,
        Operation::SharedStatus,
        json!({"workspace": "local"}),
    )
    .await
    .unwrap();
    assert_eq!(status["links"][0]["encrypted"], true);
    assert_eq!(status["links"][0]["environments"], json!(["e1"]));
    assert!(
        run(
            &application,
            Operation::SharedShare,
            json!({"workspace": "local", "collection": "c1", "path": PATH})
        )
        .await
        .is_err()
    );

    // A save reaches the file.
    let mut saved = fake
        .documents
        .lock()
        .unwrap()
        .iter()
        .find(|d| d.id.as_str() == "c1")
        .unwrap()
        .clone();
    saved.value["item"]
        .as_array_mut()
        .unwrap()
        .push(request("r2", "/b"));
    application.save_document(saved).await.unwrap();
    assert!(
        fake.shared_file(PATH)
            .unwrap()
            .0
            .to_string()
            .contains("\"/b\"")
    );

    // A teammate's change comes back, this Nexo's token and settings kept.
    let mut theirs = fake.shared_file(PATH).unwrap().0;
    theirs["collection"]["item"][1]["request"]["url"] = json!("/a2");
    theirs["collection"]["item"]
        .as_array_mut()
        .unwrap()
        .push(json!({"id": "r3", "name": "r3", "request": {"url": "/c"}}));
    theirs["environments"][0]["values"][0]["value"] = json!("https://dev2");
    fake.teammate_writes(PATH, theirs);
    let polled = run(
        &application,
        Operation::SharedPoll,
        json!({"workspace": "local"}),
    )
    .await
    .unwrap();
    assert_eq!(polled["changed"], json!(["c1"]));
    let mine = collection(&fake);
    assert_eq!(mine["item"][1]["request"]["url"], "/a2");
    assert_eq!(
        mine["item"][1]["request"]["auth"]["bearer"][0]["value"],
        "my-own-token"
    );
    assert_eq!(mine["item"].as_array().unwrap().len(), 4);
    assert_eq!(mine["nexoTransport"], "t1");
    let env = fake
        .documents
        .lock()
        .unwrap()
        .iter()
        .find(|d| d.id.as_str() == "e1")
        .unwrap()
        .value
        .clone();
    assert_eq!(env["values"][0]["value"], "https://dev2");
    assert_eq!(env["values"][1]["value"], "hunter2");
    // Nothing changed since: the poll only looks.
    let quiet = run(
        &application,
        Operation::SharedPoll,
        json!({"workspace": "local"}),
    )
    .await
    .unwrap();
    assert_eq!(quiet["changed"], json!([]));
}
