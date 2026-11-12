use super::*;

fn settings(entries: &[(&str, &str)]) -> Map<String, Value> {
    entries
        .iter()
        .map(|(k, v)| (k.to_string(), json!(v)))
        .collect()
}
fn get(url: &str) -> url::Url {
    url::Url::parse(url).unwrap()
}

#[test]
fn matches_the_rfc_2617_example() {
    // RFC 2617 section 3.5: Mufasa / "Circle Of Life", qop=auth.
    let auth = settings(&[
        ("username", "Mufasa"),
        ("password", "Circle Of Life"),
        ("realm", "testrealm@host.com"),
        ("nonce", "dcd98b7102dd2f0e8b11d0f600bfb0c093"),
        ("qop", "auth"),
        ("nonceCount", "00000001"),
        ("clientNonce", "0a4f113b"),
        ("opaque", "5ccc069c403ebaf9f0171e9517f40e41"),
    ]);
    let header = header(
        &auth,
        "GET",
        &get("http://www.nowhere.org/dir/index.html"),
        b"",
    )
    .unwrap();
    assert_eq!(
        header,
        "Digest username=\"Mufasa\", realm=\"testrealm@host.com\", \
             nonce=\"dcd98b7102dd2f0e8b11d0f600bfb0c093\", uri=\"/dir/index.html\", \
             algorithm=\"MD5\", qop=auth, nc=00000001, cnonce=\"0a4f113b\", \
             response=\"6629fae49393a05397450978507c4ef1\", opaque=\"5ccc069c403ebaf9f0171e9517f40e41\""
    );
}

#[test]
fn matches_the_rfc_2069_example_without_qop() {
    let auth = settings(&[
        ("username", "Mufasa"),
        ("password", "Circle Of Life"),
        ("realm", "testrealm@host.com"),
        ("nonce", "dcd98b7102dd2f0e8b11d0f600bfb0c093"),
    ]);
    let header = header(&auth, "GET", &get("http://x.test/dir/index.html"), b"").unwrap();
    assert!(
        header.contains("response=\"670fd8c2df070c60b045671b8b24ff02\""),
        "{header}"
    );
}

#[test]
fn matches_the_rfc_7616_sha256_example() {
    // RFC 7616 section 3.9.1, SHA-256.
    let auth = settings(&[
        ("username", "Mufasa"),
        ("password", "Circle of Life"),
        ("realm", "http-auth@example.org"),
        ("nonce", "7ypf/xlj9XXwfDPEoM4URrv/xwf94BcCAzFZH4GiTo0v"),
        ("qop", "auth"),
        ("nonceCount", "00000001"),
        (
            "clientNonce",
            "f2/wE4q74E6zIJEtWaHKaf5wv/H5QzzpXusqGemxURZJ",
        ),
        ("algorithm", "SHA-256"),
    ]);
    let header = header(
        &auth,
        "GET",
        &get("http://www.example.org/dir/index.html"),
        b"",
    )
    .unwrap();
    assert!(
        header.contains(
            "response=\"753927fa0e85d155564e2e272a28d1802ca10daf4496794697cf8db5856cb6c1\""
        ),
        "{header}"
    );
}

#[test]
fn auth_int_signs_the_body_and_sha_512_256_is_supported() {
    let mut auth = settings(&[
        ("username", "u"),
        ("password", "p"),
        ("realm", "r"),
        ("nonce", "n"),
        ("qop", "auth-int"),
        ("clientNonce", "c"),
        ("algorithm", "SHA-512-256-sess"),
    ]);
    let url = get("http://x.test/a?b=1");
    let one = header(&auth, "POST", &url, b"one").unwrap();
    let two = header(&auth, "POST", &url, b"two").unwrap();
    assert_ne!(one, two);
    assert!(one.contains("uri=\"/a?b=1\""));
    assert!(one.contains("qop=auth-int, nc=00000001, cnonce=\"c\""));
    auth.insert("algorithm".into(), json!("SHA-1"));
    assert!(header(&auth, "GET", &url, b"").is_err());
}

#[test]
fn chooses_the_challenge_of_the_selected_algorithm() {
    let challenges = vec![
        "Basic realm=\"x\"".to_string(),
        "Digest realm=\"r\", nonce=\"md5\"".to_string(),
        "Digest realm=\"r\", nonce=\"sha\", algorithm=SHA-256".to_string(),
    ];
    assert!(choose(&challenges, "SHA-256").unwrap().contains("\"sha\""));
    assert!(choose(&challenges, "MD5").unwrap().contains("\"md5\""));
    assert!(choose(&challenges, "").unwrap().contains("\"md5\""));
    assert!(choose(&challenges[..1], "").is_none());
}

#[test]
fn reads_quoted_and_bare_fields() {
    let challenge = "Digest realm=\"a, b\", qop=\"auth,auth-int\", nonce=xyz, stale=false";
    assert_eq!(field(challenge, "realm").as_deref(), Some("a, b"));
    assert_eq!(field(challenge, "qop").as_deref(), Some("auth,auth-int"));
    assert_eq!(field(challenge, "nonce").as_deref(), Some("xyz"));
    assert_eq!(field(challenge, "opaque"), None);
}
