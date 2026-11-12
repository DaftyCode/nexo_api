use super::*;
use crate::transport::HeaderList;
use serde_json::json;

/// The credentials and cases of Akamai's EdgeGrid libraries (`testdata.json` and
/// `testcases.json` of AkamaiOPEN-edgegrid-python), shared by every official client.
const BASE: &str = "https://akaa-baseurl-xxxxxxxxxxx-xxxxxxxxxxxxx.luna.akamaiapis.net";
const NONCE: &str = "nonce-xx-xxxx-xxxx-xxxx-xxxxxxxxxxxx";
const TIMESTAMP: &str = "20140321T19:34:21+0000";

/// An official case: method, path, body, headers and the expected signature.
type Case<'a> = (&'a str, &'a str, String, Vec<(&'a str, &'a str)>, &'a str);

fn signed(
    method: &str,
    path: &str,
    body: &[u8],
    headers: &[(&str, &str)],
    extra: &[(&str, Value)],
) -> String {
    let mut rows = vec![
        json!({"key": "accessToken", "value": "akab-access-token-xxx-xxxxxxxxxxxxxxxx"}),
        json!({"key": "clientToken", "value": "akab-client-token-xxx-xxxxxxxxxxxxxxxx"}),
        json!({"key": "clientSecret", "value": "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx="}),
        json!({"key": "nonce", "value": NONCE}),
        json!({"key": "timestamp", "value": TIMESTAMP}),
        json!({"key": "headersToSign", "value": "X-Test1,X-Test2,X-Test3"}),
        json!({"key": "maxBodySize", "value": "2048"}),
    ];
    for (key, value) in extra {
        rows.push(json!({"key": key, "value": value}));
    }
    let mut url = url::Url::parse(&format!("{BASE}{path}")).unwrap();
    let mut list = HeaderList::default();
    list.set("Authorization", "Basic old");
    for (name, value) in headers {
        list.append(name, value);
    }
    sign(
        &crate::auth::values(&json!({"type": "edgegrid", "edgegrid": rows})),
        &mut Outgoing {
            method,
            url: &mut url,
            headers: &mut list,
            body: &mut body.to_vec(),
            credential_headers: &mut Vec::new(),
        },
    )
    .unwrap();
    let header = list.get("authorization");
    assert_eq!(header.len(), 1);
    header[0].to_string()
}

#[test]
fn matches_the_akamai_test_cases() {
    let cases: Vec<Case> = vec![
        (
            "GET",
            "/",
            String::new(),
            vec![],
            "tL+y4hxyHxgWVD30X3pWnGKHcPzmrIF+LThiAOhMxYU=",
        ),
        (
            "GET",
            "/testapi/v1/t1?p1=1&p2=2",
            String::new(),
            vec![],
            "hKDH1UlnQySSHjvIcZpDMbQHihTQ0XyVAKZaApabdeA=",
        ),
        (
            "POST",
            "/testapi/v1/t3",
            "data".repeat(8),
            vec![],
            "hXm4iCxtpN22m4cbZb4lVLW5rhX8Ca82vCFqXzSTPe4=",
        ),
        (
            "POST",
            "/testapi/v1/t3",
            "d".repeat(2049),
            vec![],
            "6Q6PiTipLae6n4GsSIDTCJ54bEbHUBp+4MUXrbQCBoY=",
        ),
        (
            "POST",
            "/testapi/v1/t3",
            "d".repeat(2048),
            vec![],
            "6Q6PiTipLae6n4GsSIDTCJ54bEbHUBp+4MUXrbQCBoY=",
        ),
        (
            "POST",
            "/testapi/v1/t6",
            String::new(),
            vec![],
            "1gEDxeQGD5GovIkJJGcBaKnZ+VaPtrc4qBUHixjsPCQ=",
        ),
        (
            "GET",
            "/testapi/v1/t4",
            String::new(),
            vec![("X-Test1", "test-simple-header")],
            "8F9AybcRw+PLxnvT+H0JRkjROrrUgsxJTnRXMzqvcwY=",
        ),
        (
            "GET",
            "/testapi/v1/t4",
            String::new(),
            vec![("X-Test1", "\"     test-header-with-spaces     \"")],
            "ucq2AbjCNtobHfCTuS38fdkl5UDdWHZhQX46fYR8CqI=",
        ),
        (
            "GET",
            "/testapi/v1/t4",
            String::new(),
            vec![("X-Test1", "     first-thing      second-thing")],
            "WtnneL539UadAAOJwnsXvPqT4Kt6z7HMgBEwAFpt3+c=",
        ),
        (
            "GET",
            "/testapi/v1/t4",
            String::new(),
            vec![("X-Test2", "t2"), ("X-Test1", "t1"), ("X-Test3", "t3")],
            "Wus73Nx8jOYM+kkBFF2q8D1EATRIMr0WLWwpLBgkBqY=",
        ),
        (
            "GET",
            "/testapi/v1/t5",
            String::new(),
            vec![
                ("X-Test2", "t2"),
                ("X-Test1", "t1"),
                ("X-Test3", "t3"),
                ("X-Extra", "this won't be included"),
            ],
            "Knd/jc0A5Ghhizjayr0AUUvl2MZjBpS3FDSzvtq4Ixc=",
        ),
        (
            "PUT",
            "/testapi/v1/t6",
            "P".repeat(31),
            vec![],
            "GNBWEYSEWOLtu+7dD52da2C39aX/Jchpon3K/AmBqBU=",
        ),
        (
            "PATCH",
            "/testapi/v1/t6",
            "P".repeat(31),
            vec![],
            "JIl05ImY1AOnMtmw+9LKgaFA8mnzsEKabbnHmI8LsQ4=",
        ),
        (
            "GET",
            "/testapi/v1/configs/111?from=12345&limit=200000",
            String::new(),
            vec![],
            "XM+hsuSs6nuy/5eDRty1IjtVCAdr8xPFRAZ/b8RXDm8=",
        ),
        (
            "GET",
            "/testapi/v1/configs/111;222;333?from=12345&limit=200000",
            String::new(),
            vec![],
            "pmQF7Is2+O4r/mMojPR4yeF58BrempNNoBX5/DT0Fxs=",
        ),
    ];
    for (method, path, body, headers, signature) in cases {
        let header = signed(method, path, body.as_bytes(), &headers, &[]);
        assert_eq!(
            header,
            format!(
                "EG1-HMAC-SHA256 client_token=akab-client-token-xxx-xxxxxxxxxxxxxxxx;access_token=akab-access-token-xxx-xxxxxxxxxxxxxxxx;timestamp={TIMESTAMP};nonce={NONCE};signature={signature}"
            ),
            "{method} {path}"
        );
    }
}

#[test]
fn signs_the_base_url_host_and_generates_nonce_and_timestamp() {
    // The JSON request of the Python library's tests (`jsontest_hash`), sent to another host
    // and signed for the base URL's host, as Postman's `baseURL` does.
    let mut url = url::Url::parse("https://127.0.0.1:9000/testapi/v1/t3?extended=true").unwrap();
    let mut list = HeaderList::default();
    sign(
        &crate::auth::values(&json!({"type": "edgegrid", "edgegrid": [
            {"key": "accessToken", "value": "akab-access-token-xxx-xxxxxxxxxxxxxxxx"},
            {"key": "clientToken", "value": "akab-client-token-xxx-xxxxxxxxxxxxxxxx"},
            {"key": "clientSecret", "value": "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx="},
            {"key": "nonce", "value": NONCE},
            {"key": "timestamp", "value": TIMESTAMP},
            {"key": "baseURL", "value": format!("{BASE}/")},
        ]})),
        &mut Outgoing {
            method: "POST",
            url: &mut url,
            headers: &mut list,
            body: &mut br#"{"key": "value"}"#.to_vec(),
            credential_headers: &mut Vec::new(),
        },
    )
    .unwrap();
    assert!(
        list.get("authorization")[0]
            .ends_with(";signature=nONuDe50qGrPius4Rg4D2jfi/2zDZWAYRUG6RudJLNM="),
        "{:?}",
        list.get("authorization")
    );
    assert_eq!(
        base_host("https://host.example/"),
        Some("host.example".into())
    );
    assert_eq!(
        base_host("host.example:8443"),
        Some("host.example:8443".into())
    );
    assert_eq!(base_host(""), None);

    let generated = signed(
        "GET",
        "/",
        b"",
        &[],
        &[("nonce", json!("")), ("timestamp", json!(""))],
    );
    let fields: Vec<&str> = generated.split(';').collect();
    let timestamp = fields[2].trim_start_matches("timestamp=");
    assert_eq!(timestamp.len(), 22, "{timestamp}");
    assert!(timestamp.ends_with("+0000") && &timestamp[8..9] == "T" && &timestamp[11..12] == ":");
    assert_eq!(fields[3].trim_start_matches("nonce=").len(), 36);
}

#[test]
fn does_nothing_without_the_three_tokens() {
    let mut url = url::Url::parse(BASE).unwrap();
    let mut list = HeaderList::default();
    list.set("Authorization", "Basic old");
    sign(
        &crate::auth::values(&json!({"type": "edgegrid", "edgegrid": [
            {"key": "accessToken", "value": "a"}, {"key": "clientToken", "value": "c"},
        ]})),
        &mut Outgoing {
            method: "GET",
            url: &mut url,
            headers: &mut list,
            body: &mut Vec::new(),
            credential_headers: &mut Vec::new(),
        },
    )
    .unwrap();
    assert_eq!(list.get("authorization"), ["Basic old"]);
}
