use super::*;

fn settings(provider: Provider, model: &str) -> Settings {
    Settings {
        provider,
        base: provider
            .base_url(Some("https://ai.test/v1"))
            .unwrap_or_default(),
        model: model.into(),
        key: Some("sk-secret".into()),
        effort: Some("high"),
    }
}
fn said(role: Role, text: &str) -> Message {
    Message {
        role,
        text: text.into(),
    }
}
fn body(call: &Call) -> Value {
    serde_json::from_str(call.body.as_deref().unwrap()).unwrap()
}

#[test]
fn anthropic_gets_its_messages_with_effort_cache_and_fallbacks() {
    let messages = [
        said(Role::User, "Hi"),
        said(Role::Assistant, "Hello"),
        said(Role::User, "SQL?"),
    ];
    let call = chat(
        &settings(Provider::Anthropic, "claude-opus-5-5"),
        &messages,
        "Be brief",
    )
    .unwrap();
    assert_eq!(call.url, "https://ai.test/v1/messages");
    assert!(
        call.headers
            .contains(&("x-api-key".into(), "sk-secret".into()))
    );
    assert!(
        call.headers
            .contains(&("anthropic-version".into(), ANTHROPIC_VERSION.into()))
    );
    assert!(
        call.headers
            .iter()
            .any(|(name, _)| name == "anthropic-beta")
    );
    let sent = body(&call);
    assert_eq!(sent["system"], "Be brief");
    assert_eq!(sent["stream"], true);
    assert_eq!(sent["output_config"]["effort"], "high");
    assert_eq!(sent["fallbacks"], "default");
    assert_eq!(
        sent["thinking"],
        json!({"type": "adaptive", "display": "summarized"})
    );
    assert_eq!(sent["messages"][1]["role"], "assistant");
    assert!(sent.get("temperature").is_none());
    // An older model has no fallbacks.
    let older = chat(
        &settings(Provider::Anthropic, "claude-haiku-4-5"),
        &messages,
        "",
    )
    .unwrap();
    assert!(body(&older).get("fallbacks").is_none());
    assert!(body(&older).get("thinking").is_none());
    assert!(body(&older).get("system").is_none());
    assert!(
        !older
            .headers
            .iter()
            .any(|(name, _)| name == "anthropic-beta")
    );
}

#[test]
fn openai_and_compatible_servers_get_chat_completions() {
    let messages = [said(Role::User, "Hi")];
    let call = chat(&settings(Provider::Openai, "gpt-x"), &messages, "Rules").unwrap();
    assert_eq!(call.url, "https://ai.test/v1/chat/completions");
    assert_eq!(
        call.headers,
        [("authorization".to_owned(), "Bearer sk-secret".to_owned())]
    );
    let sent = body(&call);
    assert_eq!(sent["messages"][0]["role"], "system");
    assert_eq!(sent["messages"][1]["content"], "Hi");
    assert_eq!(sent["stream_options"]["include_usage"], true);
    // Their reasoning comes without being asked.
    assert!(sent.get("thinking").is_none() && sent.get("reasoning_effort").is_none());
    let mut keyless = settings(Provider::Compatible, "local");
    keyless.key = None;
    assert!(chat(&keyless, &messages, "").unwrap().headers.is_empty());
    assert!(chat(&settings(Provider::Openai, " "), &messages, "").is_err());
}

#[test]
fn gemini_gets_its_contents_and_streams_by_sse() {
    let messages = [
        said(Role::User, "Hi"),
        said(Role::Assistant, "Yes"),
        said(Role::User, "More"),
    ];
    let call = chat(
        &settings(Provider::Gemini, "models/gemini-x"),
        &messages,
        "Rules",
    )
    .unwrap();
    assert_eq!(
        call.url,
        "https://ai.test/v1/models/gemini-x:streamGenerateContent?alt=sse"
    );
    assert_eq!(
        call.headers,
        [("x-goog-api-key".to_owned(), "sk-secret".to_owned())]
    );
    let sent = body(&call);
    assert_eq!(sent["contents"][1]["role"], "model");
    assert_eq!(sent["systemInstruction"]["parts"][0]["text"], "Rules");
    assert!(sent.get("generationConfig").is_none());
    let thinks = chat(&settings(Provider::Gemini, "gemini-2.5-pro"), &messages, "").unwrap();
    assert_eq!(
        body(&thinks)["generationConfig"]["thinkingConfig"]["includeThoughts"],
        true
    );
    let odd = chat(&settings(Provider::Gemini, "a/b c"), &messages, "").unwrap();
    assert!(odd.url.contains("models/a%2Fb%20c:"), "{}", odd.url);
}

#[test]
fn the_models_are_listed_by_pages() {
    let anthropic = settings(Provider::Anthropic, "");
    assert_eq!(
        models(&anthropic, None).url,
        "https://ai.test/v1/models?limit=1000"
    );
    assert_eq!(
        models(&anthropic, Some("claude-x")).url,
        "https://ai.test/v1/models?limit=1000&after_id=claude-x"
    );
    assert_eq!(
        models(&settings(Provider::Openai, ""), Some("x")).url,
        "https://ai.test/v1/models?after_id=x"
    );
    let page = json!({"data": [{"id": "claude-opus-5-5", "display_name": "Claude Opus 5.5"}, {"id": ""}], "has_more": true, "last_id": "claude-opus-5-5"});
    let (found, next) = model_page(Provider::Anthropic, &page);
    assert_eq!(
        found,
        [Model {
            id: "claude-opus-5-5".into(),
            name: "Claude Opus 5.5".into()
        }]
    );
    assert_eq!(next.as_deref(), Some("claude-opus-5-5"));
    let gemini = json!({"models": [
        {"name": "models/gemini-pro", "displayName": "Gemini Pro", "supportedGenerationMethods": ["generateContent"]},
        {"name": "models/embedding", "supportedGenerationMethods": ["embedContent"]},
    ], "nextPageToken": ""});
    let (found, next) = model_page(Provider::Gemini, &gemini);
    assert_eq!(found.len(), 1);
    assert_eq!(found[0].id, "gemini-pro");
    assert_eq!(next, None);
    assert_eq!(
        models(&settings(Provider::Gemini, ""), Some("t")).url,
        "https://ai.test/v1/models?pageSize=1000&pageToken=t"
    );
}

#[test]
fn a_refused_call_says_why() {
    let body = json!({"type": "error", "error": {"type": "authentication_error", "message": "invalid x-api-key"}}).to_string();
    assert_eq!(
        failure(401, &body, None),
        "The provider refused the API key: check it in Settings (invalid x-api-key)"
    );
    assert_eq!(
        failure(429, "{}", Some("20")),
        "Too many requests: try again in 20 s"
    );
    assert!(failure(429, "", None).starts_with("Too many requests: try again in a moment"));
    assert!(failure(529, "", None).contains("overloaded"));
    assert!(failure(503, "", None).contains("failed"));
    assert!(failure(404, "{\"message\": \"no model\"}", None).ends_with("(no model)"));
    assert_eq!(
        failure(418, "teapot", None),
        "The provider answered HTTP 418 (teapot)"
    );
    assert!(failure(400, "{\"error\": \"plain\"}", None).ends_with("(plain)"));
}
