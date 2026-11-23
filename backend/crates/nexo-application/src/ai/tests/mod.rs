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

/// A local model that always answers the same server.
struct Local;
#[async_trait::async_trait]
impl crate::ports::LocalModel for Local {
    async fn status(&self) -> Result<crate::ports::LocalStatus> {
        Ok(crate::ports::LocalStatus {
            backend: "vulkan".into(),
            ..Default::default()
        })
    }
    async fn install(&self, model: Option<String>) -> Result<crate::ports::LocalStatus> {
        Ok(crate::ports::LocalStatus {
            installing: true,
            model,
            ..Default::default()
        })
    }
    async fn use_file(&self, path: String) -> Result<crate::ports::LocalStatus> {
        Ok(crate::ports::LocalStatus {
            model_name: Some(path),
            ..Default::default()
        })
    }
    async fn remove(&self) -> Result<crate::ports::LocalStatus> {
        Ok(crate::ports::LocalStatus::default())
    }
    async fn endpoint(&self) -> Result<crate::ports::LocalEndpoint> {
        Ok(crate::ports::LocalEndpoint {
            url: "http://127.0.0.1:4321/v1".into(),
            port: 4321,
            token: "start-token".into(),
        })
    }
}

#[tokio::test]
async fn the_local_model_answers_on_loopback_with_the_key_of_its_start() {
    let (application, fake) = application();
    let refused = application
        .execute(Operation::AiLocalStatus, json!({}))
        .await
        .unwrap_err();
    assert!(refused.to_string().contains("cannot run a local model"));
    let application = application.with_local_model(Arc::new(Local));
    let status = application
        .execute(Operation::AiLocalStatus, json!({}))
        .await
        .unwrap();
    assert_eq!(status["backend"], "vulkan");
    let installing = application
        .execute(Operation::AiLocalInstall, json!({"model": "qwen3.5-4b"}))
        .await
        .unwrap();
    assert_eq!(
        (
            installing["installing"].clone(),
            installing["model"].clone()
        ),
        (json!(true), json!("qwen3.5-4b"))
    );
    let file = application
        .execute(
            Operation::AiLocalFile,
            json!({"path": "C:/models/mine.gguf"}),
        )
        .await
        .unwrap();
    assert_eq!(file["modelName"], "C:/models/mine.gguf");
    application
        .execute(Operation::AiLocalRemove, json!({}))
        .await
        .unwrap();
    let mut chat = json!({"provider": "local", "model": "local", "messages": [{"role": "user", "text": "Hi"}]});
    chat["route"] = json!({"via": "http", "profile": "p1"});
    application.execute(Operation::AiChat, chat).await.unwrap();
    let (operation, sent) = fake.executed.lock().unwrap().remove(0);
    assert_eq!(operation, "ai.chat");
    assert_eq!(sent["baseUrl"], "http://127.0.0.1:4321/v1");
    assert_eq!(sent["resolvedKey"], "start-token");
    assert_eq!(sent["egressLoopbackPorts"], json!([4321]));
    assert!(
        sent.get("route").is_none(),
        "the local model is never reached through a proxy"
    );
}

mod connections;
mod tools;
