//! The key of the provider comes from the vault, what leaves has no value of the vault, and
//! without a key nothing is called.
use crate::testing::*;

fn chat(provider: &str, text: &str) -> Value {
    json!({
        "provider": provider,
        "model": "claude-opus-5-5",
        "system": "Rules with secret-of-db-password",
        "messages": [{"role": "user", "text": text}],
    })
}

#[tokio::test]
async fn the_key_comes_from_the_vault_and_secrets_never_leave() {
    let (application, fake) = application();
    fake.listed
        .lock()
        .unwrap()
        .extend(["db-password".to_owned(), "ai:anthropic".to_owned()]);
    application
        .execute(
            Operation::AiChat,
            chat("anthropic", "Why does secret-of-db-password fail?"),
        )
        .await
        .unwrap();
    let (operation, sent) = fake.executed.lock().unwrap().remove(0);
    assert_eq!(operation, "ai.chat");
    assert_eq!(sent["resolvedKey"], "secret-of-ai:anthropic");
    assert_eq!(sent["messages"][0]["text"], "Why does [redacted] fail?");
    assert_eq!(sent["system"], "Rules with [redacted]");
}

#[tokio::test]
async fn a_key_sent_by_the_interface_is_ignored() {
    let (application, fake) = application();
    let mut payload = chat("openai", "Hi");
    payload["resolvedKey"] = json!("sk-from-outside");
    application
        .execute(Operation::AiChat, payload)
        .await
        .unwrap();
    let (_, sent) = fake.executed.lock().unwrap().remove(0);
    assert_eq!(sent["resolvedKey"], "secret-of-ai:openai");
}

#[tokio::test]
async fn without_a_key_nothing_is_called() {
    let (application, fake) = application();
    fake.missing
        .lock()
        .unwrap()
        .extend(["ai:gemini".to_owned(), "ai:compatible".to_owned()]);
    let refused = application
        .execute(Operation::AiChat, chat("gemini", "Hi"))
        .await
        .unwrap_err();
    assert!(refused.to_string().contains("Settings"));
    assert!(fake.executed.lock().unwrap().is_empty());
    // A compatible server of one's own may take no key.
    application
        .execute(
            Operation::AiModels,
            json!({"provider": "compatible", "baseUrl": "http://127.0.0.1:8080/v1"}),
        )
        .await
        .unwrap();
    let (operation, sent) = fake.executed.lock().unwrap().remove(0);
    assert_eq!(operation, "ai.models");
    assert!(sent.get("resolvedKey").is_none());
    assert!(
        application
            .execute(Operation::AiModels, json!({"provider": "other"}))
            .await
            .is_err()
    );
}

#[tokio::test]
async fn polls_and_stops_go_straight_to_the_engine() {
    let (application, fake) = application();
    application
        .execute(Operation::AiPoll, json!({"id": "c1", "after": 4}))
        .await
        .unwrap();
    application
        .execute(Operation::AiStop, json!({"id": "c1"}))
        .await
        .unwrap();
    let executed = fake.executed.lock().unwrap().clone();
    assert_eq!(executed[0].0, "ai.poll");
    assert_eq!(executed[0].1["after"], 4);
    assert_eq!(executed[1].0, "ai.stop");
    assert!(
        application
            .execute(
                Operation::AiChat,
                json!({"provider": "openai", "model": "x", "messages": [], "extra": 1})
            )
            .await
            .is_err()
    );
}
