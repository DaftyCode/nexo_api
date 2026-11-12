use super::*;
#[test]
fn links_work_once_and_create_sessions() {
    let sessions = Sessions::default();
    let code = sessions.issue_link();
    let session = sessions.redeem(&code).expect("first use");
    assert!(sessions.redeem(&code).is_none(), "links are single use");
    assert!(sessions.valid(&session));
    assert!(!sessions.valid("forged"));
    sessions.close(&session);
    assert!(!sessions.valid(&session));
}
#[test]
fn parses_cookies_and_compares_tokens() {
    let mut headers = HeaderMap::new();
    headers.insert(
        header::COOKIE,
        HeaderValue::from_static("a=1; nexo_session=abc"),
    );
    assert_eq!(cookie(&headers, SESSION_COOKIE), Some("abc"));
    assert!(constant_time_eq(b"abc", b"abc"));
    assert!(!constant_time_eq(b"abc", b"abd"));
}
