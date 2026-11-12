use super::*;

fn jars() -> (Jars, PathBuf) {
    let directory = std::env::temp_dir().join(format!("nexo-cookies-{}", uuid::Uuid::new_v4()));
    (Jars::new(directory.clone()), directory)
}
/// The `Cookie` header the jar sends to an address.
fn sent(jars: &Jars, scope: &str, url: &str) -> String {
    let jar = jars.get(scope);
    let store = jar.lock().unwrap();
    let mut pairs: Vec<String> = store
        .matches(&Url::parse(url).unwrap())
        .iter()
        .map(|c| format!("{}={}", c.name(), c.value()))
        .collect();
    pairs.sort();
    pairs.join("; ")
}
fn error(input: Value) -> String {
    match parse(&input, 1_000) {
        Err(Error::Validation(message)) => message,
        other => panic!("expected a validation error, got {other:?}"),
    }
}

#[test]
fn session_and_persistent_cookies_survive_a_restart() {
    let (first, directory) = jars();
    first
        .set(
            "w1",
            &json!({"name": "session", "value": "abc", "domain": "api.test"}),
        )
        .unwrap();
    let expires = now() + 3_600_000;
    first
        .set(
            "w1",
            &json!({"name": "remember", "value": "yes", "domain": "api.test", "expires": expires}),
        )
        .unwrap();
    let again = Jars::new(directory.clone());
    assert_eq!(
        sent(&again, "w1", "http://api.test/"),
        "remember=yes; session=abc"
    );
    let listed = again.list("w1");
    assert_eq!(listed.len(), 2);
    let remembered = listed.iter().find(|c| c["name"] == "remember").unwrap();
    // Kept to the second, as an Expires attribute is.
    let kept = remembered["expires"].as_u64().unwrap();
    assert!(kept.abs_diff(expires) < 2_000, "{kept} {expires}");
    assert!(listed.iter().any(|c| c["expires"].is_null()));
    assert!(Jars::new(directory.clone()).list("w2").is_empty());
    let _ = std::fs::remove_dir_all(directory);
}

#[test]
fn cookies_are_added_edited_and_deleted_and_used_by_the_next_request() {
    let (jars, directory) = jars();
    let added = jars
        .set(
            "w1",
            &json!({"name": "id", "value": "1", "domain": ".Example.COM", "path": "/api",
                    "includeSubdomains": true, "secure": true, "httpOnly": true, "sameSite": "lax"}),
        )
        .unwrap();
    assert_eq!(
        added,
        json!({"name": "id", "value": "1", "domain": "example.com", "hostOnly": false,
               "path": "/api", "expires": null, "secure": true, "httpOnly": true, "sameSite": "Lax"})
    );
    assert_eq!(
        sent(&jars, "w1", "https://www.example.com/api/orders"),
        "id=1"
    );
    assert_eq!(
        sent(&jars, "w1", "http://www.example.com/api"),
        "",
        "secure"
    );
    assert_eq!(sent(&jars, "w1", "https://example.com/other"), "", "path");

    // Editing its name and path replaces it.
    jars.set(
        "w1",
        &json!({"name": "user", "value": "2", "domain": "example.com",
                "original": {"domain": "example.com", "path": "/api", "name": "id"}}),
    )
    .unwrap();
    assert_eq!(sent(&jars, "w1", "https://example.com/api"), "user=2");
    assert_eq!(
        sent(&jars, "w1", "https://www.example.com/"),
        "",
        "host only"
    );
    assert_eq!(jars.list("w1").len(), 1);

    assert!(!jars.delete("w1", "example.com", "/", "missing"));
    assert!(jars.delete("w1", "example.com", "/", "user"));
    assert!(jars.list("w1").is_empty());
    assert!(Jars::new(directory.clone()).list("w1").is_empty());
    let _ = std::fs::remove_dir_all(directory);
}

#[test]
fn invalid_cookies_are_refused() {
    let base = json!({"name": "a", "value": "b", "domain": "example.com"});
    let with = |key: &str, value: Value| {
        let mut input = base.clone();
        input[key] = value;
        input
    };
    assert!(parse(&base, 1_000).is_ok());
    assert_eq!(error(with("name", json!(" "))), "The cookie needs a name");
    assert!(error(with("name", json!("a b"))).contains("name cannot contain ' '"));
    assert!(error(with("name", json!("a=b"))).contains("'='"));
    assert!(error(with("value", json!("x;y"))).contains("value cannot contain ';'"));
    assert!(error(with("value", json!("x\ny"))).contains("'\\n'"));
    assert!(error(with("value", json!("x".repeat(MAX_COOKIE)))).contains("4096 bytes"));
    assert_eq!(
        error(with("domain", json!(""))),
        "The cookie needs a domain"
    );
    for domain in [
        "https://example.com",
        "example.com/path",
        "example.com:8080",
        "user@example.com",
        "exa mple.com",
        "[::1",
    ] {
        assert!(
            error(with("domain", json!(domain))).contains("is not a domain"),
            "{domain}"
        );
    }
    assert!(error(with("path", json!("api"))).contains("starts with /"));
    assert!(error(with("path", json!("/a;b"))).contains("starts with /"));
    assert_eq!(
        error(with("expires", json!(999))),
        "The expiry date has already passed"
    );
    assert!(error(with("sameSite", json!("always"))).contains("Strict, Lax or None"));
    let mut ip = with("domain", json!("127.0.0.1"));
    assert!(parse(&ip, 1_000).is_ok());
    ip["includeSubdomains"] = json!(true);
    assert!(error(ip).contains("not an IP address"));
    assert!(parse(&with("domain", json!("[::1]")), 1_000).is_ok());
    assert!(parse(&with("domain", json!("localhost")), 1_000).is_ok());
}

#[test]
fn clearing_removes_the_jar_from_disk() {
    let (jars, directory) = jars();
    jars.set(
        "w1",
        &json!({"name": "a", "value": "1", "domain": "localhost"}),
    )
    .unwrap();
    jars.clear("w1");
    assert!(jars.list("w1").is_empty());
    assert!(Jars::new(directory.clone()).list("w1").is_empty());
    let _ = std::fs::remove_dir_all(directory);
}
