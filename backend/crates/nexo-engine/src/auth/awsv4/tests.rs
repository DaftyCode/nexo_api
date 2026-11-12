use super::*;
use crate::transport::HeaderList;

const DATE: &str = "20150830T123600Z";

/// The credentials of the official test suite (aws-c-auth `aws-signing-test-suite/v4`).
fn suite(token: &str, to_query: bool) -> Credentials {
    Credentials {
        access_key: "AKIDEXAMPLE".into(),
        secret_key: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY".into(),
        session_token: token.into(),
        service: "service".into(),
        region: "us-east-1".into(),
        to_query,
    }
}

fn signed(
    credentials: &Credentials,
    method: &str,
    url: &str,
    headers: &[(&str, &str)],
    body: &[u8],
) -> (url::Url, HeaderList) {
    let mut url = url::Url::parse(url).unwrap();
    let mut list = HeaderList::default();
    for (name, value) in headers {
        list.append(name, value);
    }
    sign_at(
        credentials,
        &mut Outgoing {
            method,
            url: &mut url,
            headers: &mut list,
            body: &mut body.to_vec(),
            credential_headers: &mut Vec::new(),
        },
        DATE,
    );
    (url, list)
}

fn signature(headers: &HeaderList) -> String {
    let authorization = headers.get("authorization")[0].to_string();
    authorization
        .rsplit("Signature=")
        .next()
        .unwrap()
        .to_string()
}

#[test]
fn matches_the_official_header_vectors() {
    let credentials = suite("", false);
    for (method, url, headers, signature_hex) in [
        (
            "GET",
            "https://example.amazonaws.com/",
            &[][..],
            "5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31",
        ),
        (
            "GET",
            "https://example.amazonaws.com/?Param2=value2&Param1=value1",
            &[],
            "b97d918cfa904a5beff61c982a1b6f458b799221646efd99d3219ec94cdf2500",
        ),
        (
            "GET",
            "https://example.amazonaws.com/?-._~0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz=-._~0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz",
            &[],
            "9c3e54bfcdf0b19771a7f523ee5669cdf59bc7cc0884027167c21bb143a40197",
        ),
        (
            "GET",
            "https://example.amazonaws.com//example//",
            &[],
            "9a624bd73a37c9a373b5312afbebe7a714a789de108f0bdfe846570885f57e84",
        ),
        (
            "GET",
            "https://example.amazonaws.com/",
            &[("My-Header1", " value1"), ("My-Header2", " \"a   b   c\"")],
            "acc3ed3afb60bb290fc8d2dd0098b9911fcaa05412b367055dee359757a9c736",
        ),
        (
            "POST",
            "https://example.amazonaws.com/",
            &[],
            "5da7c1a2acd57cee7505fc6676e4e544621c30862966e37dddb68e92efbe5d6b",
        ),
    ] {
        let (_, signed_headers) = signed(&credentials, method, url, headers, b"");
        assert_eq!(signature(&signed_headers), signature_hex, "{method} {url}");
        assert_eq!(signed_headers.get("x-amz-date"), [DATE]);
    }
}

#[test]
fn signs_the_body_hash_and_the_session_token() {
    // post-x-www-form-urlencoded: the body hash is sent and signed.
    let (_, headers) = signed(
        &suite("", false),
        "POST",
        "https://example.amazonaws.com/",
        &[
            ("Content-Type", "application/x-www-form-urlencoded"),
            ("Content-Length", "13"),
        ],
        b"Param1=value1",
    );
    assert_eq!(
        headers.get("x-amz-content-sha256"),
        ["9095672bbd1f56dfc5b65f3e153adc8731a4a654192329106275f4c7b24d0b6e"]
    );
    assert_eq!(
        signature(&headers),
        "d3875051da38690788ef43de4db0d8f280229d82040bfac253562e56c3f20e0b"
    );

    // get-vanilla-with-session-token
    let token = "6e86291e8372ff2a2260956d9b8aae1d763fbf315fa00fa31553b73ebf194267";
    let (_, headers) = signed(
        &suite(token, false),
        "GET",
        "https://example.amazonaws.com/",
        &[("Authorization", "Basic old"), ("User-Agent", "Nexo")],
        b"",
    );
    assert_eq!(headers.get("x-amz-security-token"), [token]);
    let authorization = headers.get("authorization")[0];
    assert!(
        authorization.starts_with(
            "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=host;x-amz-date;x-amz-security-token, Signature="
        ),
        "{authorization}"
    );
    assert_eq!(
        signature(&headers),
        "07ec1639c89043aa0e3e2de82b96708f198cceab042d4a97044c66dd9f74e7f8"
    );
}

#[test]
fn matches_the_official_presigned_url_vectors() {
    let (url, headers) = signed(
        &suite("", true),
        "GET",
        "https://example.amazonaws.com/?X-Amz-Expires=3600&X-Amz-Signature=old",
        &[],
        b"",
    );
    assert_eq!(
        url.query(),
        Some(
            "X-Amz-Expires=3600&X-Amz-Date=20150830T123600Z&X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIDEXAMPLE%2F20150830%2Fus-east-1%2Fservice%2Faws4_request&X-Amz-SignedHeaders=host&X-Amz-Signature=e93c787ed7f371d5c6b165c1b38ede9550f4dce4144713e844b25b7192d3865d"
        )
    );
    assert!(headers.get("authorization").is_empty());

    let token = "6e86291e8372ff2a2260956d9b8aae1d763fbf315fa00fa31553b73ebf194267";
    let (url, _) = signed(
        &suite(token, true),
        "GET",
        "https://example.amazonaws.com/?X-Amz-Expires=3600",
        &[],
        b"",
    );
    assert!(
        url.query()
            .unwrap()
            .contains(&format!("X-Amz-Security-Token={token}"))
    );
    assert!(url.query().unwrap().ends_with(
        "X-Amz-Signature=7ff2b50b376cb4d151970630573d6291dc128cc5c2a12ffb237f73cc53f67b6c"
    ));
}

#[test]
fn s3_hashes_empty_bodies_keeps_paths_and_presigns_unsigned_payloads() {
    let s3 = Credentials {
        service: "s3".into(),
        ..suite("", false)
    };
    let (_, headers) = signed(
        &s3,
        "GET",
        "https://bucket.s3.amazonaws.com/a//b/../c",
        &[],
        b"",
    );
    assert_eq!(
        headers.get("x-amz-content-sha256"),
        ["e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"]
    );
    assert_eq!(canonical_path("/a//b/../c%20d", true), "/a//b/../c%20d");
    assert_eq!(canonical_path("/a//b/../c%20d", false), "/a/c%2520d");
    assert_eq!(
        canonical_query(
            &[
                ("b".into(), "2".into()),
                ("a".into(), "y".into()),
                ("a".into(), "x".into())
            ],
            false
        ),
        "a=x&a=y&b=2"
    );
    assert_eq!(
        canonical_query(&[("a".into(), "y".into()), ("a".into(), "x".into())], true),
        "a=y"
    );
    let presign = Credentials {
        to_query: true,
        ..s3
    };
    let (url, _) = signed(
        &presign,
        "GET",
        "https://bucket.s3.amazonaws.com/key",
        &[],
        b"",
    );
    assert!(
        url.query()
            .unwrap()
            .starts_with("X-Amz-Expires=86400&X-Amz-Date=")
    );
}

#[test]
fn formats_dates_and_reads_postman_bruno_and_insomnia_keys() {
    assert_eq!(amz_date(1_440_938_160), DATE);
    assert_eq!(amz_date(951_782_400), "20000229T000000Z");
    for keys in [
        ("accessKey", "secretKey"),
        ("accessKeyId", "secretAccessKey"),
    ] {
        let auth = serde_json::json!({"type": "awsv4", "awsv4": [
            {"key": keys.0, "value": "AKID"}, {"key": keys.1, "value": "secret"},
        ]});
        let (_, headers) = super::super::tests::signed(auth, "https://example.com/x");
        let authorization = headers.get("authorization")[0].to_string();
        assert!(
            authorization.starts_with("AWS4-HMAC-SHA256 Credential=AKID/")
                && authorization.contains("/us-east-1/execute-api/aws4_request"),
            "{authorization}"
        );
    }
    let profile = values(&serde_json::json!({"type": "awsv4", "awsv4": [
        {"key": "profileName", "value": "default"},
    ]}));
    let mut url = url::Url::parse("https://example.com").unwrap();
    let error = sign(
        &profile,
        &mut Outgoing {
            method: "GET",
            url: &mut url,
            headers: &mut HeaderList::default(),
            body: &mut Vec::new(),
            credential_headers: &mut Vec::new(),
        },
    )
    .unwrap_err();
    assert!(
        error
            .to_string()
            .contains("profiles from ~/.aws are not read")
    );
}

use crate::auth::values;
