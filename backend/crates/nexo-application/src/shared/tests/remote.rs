//! A collection shared through the URL of a server: its credential goes to the vault, the
//! server is asked only when the workspace opens or after a save met a teammate's change,
//! never on a schedule, and with the version this Nexo knows.
use super::*;

const URL: &str = "https://dav.test/team/Shop.nexo-collection";

fn reads(fake: &Fake) -> usize {
    fake.executed
        .lock()
        .unwrap()
        .iter()
        .filter(|(operation, _)| operation == "shared.read")
        .count()
}

#[tokio::test]
async fn a_server_is_asked_only_on_opening_or_after_a_save_met_a_change() {
    let (application, fake) = shop();
    let credential = json!({"scheme": "basic", "user": "ana", "secret": "dav-password"});
    let shared = run(&application, Operation::SharedShare, json!({"workspace": "local", "collection": "c1", "url": URL, "credential": credential, "encrypt": false}))
        .await
        .unwrap();
    assert!(shared["key"].is_null());
    assert_eq!(
        fake.stored
            .lock()
            .unwrap()
            .get("shared: Shop (c1)")
            .map(String::as_str),
        Some("dav-password")
    );
    let link = fake
        .documents
        .lock()
        .unwrap()
        .iter()
        .find(|d| d.kind == DocumentKind::SharedLink)
        .unwrap()
        .clone();
    assert!(!link.value.to_string().contains("dav-password"));
    assert_eq!(link.value["location"]["auth"]["user"], "ana");
    let written = fake
        .executed
        .lock()
        .unwrap()
        .iter()
        .rev()
        .find(|(operation, _)| operation == "shared.write")
        .unwrap()
        .1
        .clone();
    assert_eq!(
        written["resolvedAuth"],
        json!({"scheme": "basic", "user": "ana", "password": "dav-password"})
    );
    let status = run(
        &application,
        Operation::SharedStatus,
        json!({"workspace": "local"}),
    )
    .await
    .unwrap();
    assert_eq!(
        (
            status["links"][0]["kind"].clone(),
            status["links"][0]["path"].clone()
        ),
        (json!("url"), json!(URL))
    );

    // A teammate writes; the look every few seconds does not ask the server.
    let mut theirs = fake.shared_file(URL).unwrap().0;
    theirs["collection"]["item"][1]["request"]["url"] = json!("/theirs");
    fake.teammate_writes(URL, theirs);
    let before = reads(&fake);
    let quiet = run(
        &application,
        Operation::SharedPoll,
        json!({"workspace": "local"}),
    )
    .await
    .unwrap();
    assert_eq!(
        (quiet["changed"].clone(), reads(&fake)),
        (json!([]), before)
    );
    // Opening the workspace asks, with the version it knows.
    let opened = run(
        &application,
        Operation::SharedPoll,
        json!({"workspace": "local", "opening": true}),
    )
    .await
    .unwrap();
    assert_eq!(opened["changed"], json!(["c1"]));
    assert_eq!(collection(&fake)["item"][1]["request"]["url"], "/theirs");
    let asked = fake
        .executed
        .lock()
        .unwrap()
        .iter()
        .rev()
        .find(|(operation, _)| operation == "shared.read")
        .unwrap()
        .1
        .clone();
    assert!(asked["known"].is_string());
    // Nothing changed since: the server says so and sends nothing.
    let again = run(
        &application,
        Operation::SharedPoll,
        json!({"workspace": "local", "opening": true}),
    )
    .await
    .unwrap();
    assert_eq!(again["changed"], json!([]));

    // A save that meets a teammate's change leaves the collection behind; the next look joins.
    let mut theirs = fake.shared_file(URL).unwrap().0;
    theirs["collection"]["item"]
        .as_array_mut()
        .unwrap()
        .push(json!({"id": "r9", "name": "r9", "request": {"url": "/r9"}}));
    fake.teammate_writes(URL, theirs);
    let mut mine = fake
        .documents
        .lock()
        .unwrap()
        .iter()
        .find(|d| d.id.as_str() == "c1")
        .unwrap()
        .clone();
    mine.value["item"][1]["request"]["url"] = json!("/mine");
    application.save_document(mine).await.unwrap();
    let joined = run(
        &application,
        Operation::SharedPoll,
        json!({"workspace": "local"}),
    )
    .await
    .unwrap();
    assert_eq!(joined["changed"], json!(["c1"]));
    let now = collection(&fake);
    assert_eq!(now["item"][1]["request"]["url"], "/mine");
    assert_eq!(now["item"].as_array().unwrap().len(), 3);
    assert!(
        fake.shared_file(URL)
            .unwrap()
            .0
            .to_string()
            .contains("/mine")
    );
}

#[tokio::test]
async fn a_server_collection_is_brought_in_with_its_credential() {
    let (application, fake) = shop();
    let content =
        json!({"collection": {"info": {"name": "Remote API"}, "item": []}, "environments": []});
    fake.shared
        .lock()
        .unwrap()
        .files
        .insert(URL.into(), (content, None, 3));
    let bring = |url: &str, scheme: &str| {
        run(
            &application,
            Operation::SharedLink,
            json!({"workspace": "local", "url": url, "credential": {"scheme": scheme, "secret": "tok"}}),
        )
    };
    assert!(
        bring("ftp://dav.test/x.nexo-collection", "bearer")
            .await
            .is_err()
    );
    assert!(bring("https://dav.test/x.json", "bearer").await.is_err());
    let linked = bring(URL, "bearer").await.unwrap();
    let read = fake
        .executed
        .lock()
        .unwrap()
        .iter()
        .rev()
        .find(|(operation, _)| operation == "shared.read")
        .unwrap()
        .1
        .clone();
    assert_eq!(
        read["resolvedAuth"],
        json!({"scheme": "bearer", "token": "tok"})
    );
    assert!(
        fake.stored
            .lock()
            .unwrap()
            .values()
            .any(|stored| stored == "tok")
    );
    assert!(linked["collection"].is_string());
    assert!(
        bring(URL, "none")
            .await
            .unwrap_err()
            .to_string()
            .contains("already in this workspace")
    );
    // Without its credential in the vault, the link says so.
    let link = fake
        .documents
        .lock()
        .unwrap()
        .iter()
        .find(|d| d.kind == DocumentKind::SharedLink)
        .unwrap()
        .clone();
    let name = link.value["location"]["auth"]["secretName"]
        .as_str()
        .unwrap()
        .to_owned();
    fake.stored.lock().unwrap().remove(&name);
    fake.missing.lock().unwrap().push(name);
    let polled = run(
        &application,
        Operation::SharedPoll,
        json!({"workspace": "local", "opening": true}),
    )
    .await
    .unwrap();
    assert!(
        polled["links"][0]["error"]
            .as_str()
            .unwrap()
            .contains("credential")
    );
}
