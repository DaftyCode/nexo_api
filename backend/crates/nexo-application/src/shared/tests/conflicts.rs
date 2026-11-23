//! What both people changed is asked, and either side kept.
use super::*;

#[tokio::test]
async fn what_both_changed_is_asked_and_either_side_kept() {
    let (application, fake) = shop();
    run(
        &application,
        Operation::SharedShare,
        json!({"workspace": "local", "collection": "c1", "path": PATH, "encrypt": false}),
    )
    .await
    .unwrap();
    assert!(fake.shared_file(PATH).unwrap().1.is_none());
    let mut theirs = fake.shared_file(PATH).unwrap().0;
    theirs["collection"]["item"][1]["request"]["url"] = json!("/theirs");
    fake.teammate_writes(PATH, theirs);
    let mut mine = fake
        .documents
        .lock()
        .unwrap()
        .iter()
        .find(|d| d.id.as_str() == "c1")
        .unwrap()
        .clone();
    mine.value["item"][1]["request"]["url"] = json!("/mine");
    let saved = application.save_document(mine).await.unwrap();
    // The save keeps what the person wrote; the poll joins both, keeps theirs and asks.
    assert_eq!(saved.value["item"][1]["request"]["url"], "/mine");
    let polled = run(
        &application,
        Operation::SharedPoll,
        json!({"workspace": "local"}),
    )
    .await
    .unwrap();
    assert_eq!(polled["changed"], json!(["c1"]));
    assert_eq!(collection(&fake)["item"][1]["request"]["url"], "/theirs");
    let status = run(
        &application,
        Operation::SharedStatus,
        json!({"workspace": "local"}),
    )
    .await
    .unwrap();
    assert_eq!(
        status["links"][0]["conflicts"],
        json!([{"id": "r1", "name": "r1"}])
    );
    run(
        &application,
        Operation::SharedResolve,
        json!({"workspace": "local", "collection": "c1", "id": "r1", "keep": "mine"}),
    )
    .await
    .unwrap();
    assert_eq!(collection(&fake)["item"][1]["request"]["url"], "/mine");
    assert!(
        fake.shared_file(PATH)
            .unwrap()
            .0
            .to_string()
            .contains("/mine")
    );
    let after = run(
        &application,
        Operation::SharedStatus,
        json!({"workspace": "local"}),
    )
    .await
    .unwrap();
    assert_eq!(after["links"][0]["conflicts"], json!([]));
    assert!(
        run(
            &application,
            Operation::SharedResolve,
            json!({"workspace": "local", "collection": "c1", "id": "r1", "keep": "theirs"})
        )
        .await
        .is_err()
    );
}
