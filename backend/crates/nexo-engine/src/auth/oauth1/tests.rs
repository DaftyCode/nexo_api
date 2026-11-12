use super::*;
use crate::{auth::values, transport::HeaderList};
use serde_json::json;

#[test]
fn builds_twitter_documented_base_string() {
    let (auth, url, _, body) = twitter(&[]);
    let mut parameters: Vec<(String, String)> = [
        ("oauth_consumer_key", "xvz1evFS4wEEPTGEFPHBog"),
        (
            "oauth_token",
            "370773112-GmHxMAgYyLbNEtIKZeRNFsMKPR9EyMZeS9weJAEb",
        ),
        ("oauth_signature_method", "HMAC-SHA1"),
        ("oauth_timestamp", "1318622958"),
        ("oauth_nonce", "kYjzVBB8Y0ZFabxSWbWovY3uYSQ2pTgmZeNu2VS4cg"),
        ("oauth_version", "1.0"),
    ]
    .iter()
    .map(|(k, v)| (k.to_string(), v.to_string()))
    .collect();
    parameters.extend(decode_form(std::str::from_utf8(&body).unwrap()));
    assert!(auth.contains_key("consumerKey"));
    assert_eq!(
        base_string("POST", &url, &parameters),
        "POST&https%3A%2F%2Fapi.twitter.com%2F1.1%2Fstatuses%2Fupdate.json&include_entities%3Dtrue%26oauth_consumer_key%3Dxvz1evFS4wEEPTGEFPHBog%26oauth_nonce%3DkYjzVBB8Y0ZFabxSWbWovY3uYSQ2pTgmZeNu2VS4cg%26oauth_signature_method%3DHMAC-SHA1%26oauth_timestamp%3D1318622958%26oauth_token%3D370773112-GmHxMAgYyLbNEtIKZeRNFsMKPR9EyMZeS9weJAEb%26oauth_version%3D1.0%26status%3DHello%2520Ladies%2520%252B%2520Gentlemen%252C%2520a%2520signed%2520OAuth%2520request%2521"
    );
}

/// Twitter's documented example ("Creating a signature"): hCtSmYh+iHYCEqBWrE7C7hYmtUk=.
fn twitter(extra: &[(&str, Value)]) -> (Map<String, Value>, url::Url, HeaderList, Vec<u8>) {
    let mut rows = vec![
        json!({"key": "consumerKey", "value": "xvz1evFS4wEEPTGEFPHBog"}),
        json!({"key": "consumerSecret", "value": "kAcSOqF21Fu85e7zjz7ZN2U4ZRhfV3WpwPAoE3Z7kBw"}),
        json!({"key": "token", "value": "370773112-GmHxMAgYyLbNEtIKZeRNFsMKPR9EyMZeS9weJAEb"}),
        json!({"key": "tokenSecret", "value": "LswwdoUaIvS8ltyTt5jkRh4J50vUPVVHtR2YPi5kE"}),
        json!({"key": "signatureMethod", "value": "HMAC-SHA1"}),
        json!({"key": "timestamp", "value": "1318622958"}),
        json!({"key": "nonce", "value": "kYjzVBB8Y0ZFabxSWbWovY3uYSQ2pTgmZeNu2VS4cg"}),
        json!({"key": "version", "value": "1.0"}),
    ];
    for (key, value) in extra {
        rows.push(json!({"key": key, "value": value}));
    }
    let mut headers = HeaderList::default();
    headers.set("content-type", "application/x-www-form-urlencoded");
    (
        values(&json!({"type": "oauth1", "oauth1": rows})),
        url::Url::parse("https://api.twitter.com/1.1/statuses/update.json?include_entities=true")
            .unwrap(),
        headers,
        b"status=Hello%20Ladies%20%2B%20Gentlemen%2C%20a%20signed%20OAuth%20request%21".to_vec(),
    )
}
fn run(
    auth: &Map<String, Value>,
    url: &mut url::Url,
    headers: &mut HeaderList,
    body: &mut Vec<u8>,
) {
    sign(
        auth,
        &mut Outgoing {
            method: "POST",
            url,
            headers,
            body,
            credential_headers: &mut Vec::new(),
        },
    )
    .unwrap();
}

#[test]
fn signs_the_twitter_example_in_the_header() {
    let (auth, mut url, mut headers, mut body) = twitter(&[("addParamsToHeader", json!(true))]);
    run(&auth, &mut url, &mut headers, &mut body);
    let header = headers.get("authorization")[0].to_string();
    assert!(
        header.starts_with("OAuth oauth_consumer_key=\"xvz1evFS4wEEPTGEFPHBog\","),
        "{header}"
    );
    assert!(
        header.contains("oauth_signature=\"hCtSmYh%2BiHYCEqBWrE7C7hYmtUk%3D\""),
        "{header}"
    );
    assert_eq!(url.query(), Some("include_entities=true"));
}

#[test]
fn adds_the_parameters_to_a_form_body_or_to_the_query() {
    let (auth, mut url, mut headers, mut body) = twitter(&[]);
    run(&auth, &mut url, &mut headers, &mut body);
    let form = String::from_utf8(body).unwrap();
    assert!(form.starts_with("status=Hello%20Ladies"), "{form}");
    assert!(
        form.contains("oauth_signature=hCtSmYh%2BiHYCEqBWrE7C7hYmtUk%3D"),
        "{form}"
    );
    assert!(headers.get("authorization").is_empty());

    // Without a form body, the signature goes in the query.
    let (auth, mut url, mut headers, _) = twitter(&[]);
    headers.delete("content-type");
    run(&auth, &mut url, &mut headers, &mut Vec::new());
    let query = url.query().unwrap();
    assert!(
        query.starts_with("include_entities=true&oauth_consumer_key="),
        "{query}"
    );
    assert!(query.contains("oauth_signature="));
}

#[test]
fn rsa_keys_must_be_pasted_not_bruno_files() {
    let (auth, mut url, mut headers, mut body) = twitter(&[
        ("signatureMethod", json!("RSA-SHA256")),
        ("privateKey", json!("keys/private.pem")),
        ("privateKeyType", json!("file")),
    ]);
    let error = sign(
        &auth,
        &mut Outgoing {
            method: "POST",
            url: &mut url,
            headers: &mut headers,
            body: &mut body,
            credential_headers: &mut Vec::new(),
        },
    )
    .unwrap_err();
    assert!(error.to_string().contains("paste the private key text"));
}

#[test]
fn plaintext_realm_empty_parameters_and_body_hash() {
    let (auth, mut url, mut headers, _) = twitter(&[
        ("signatureMethod", json!("PLAINTEXT")),
        ("addParamsToHeader", json!(true)),
        ("realm", json!("Photos")),
        ("version", json!("")),
    ]);
    headers.delete("content-type");
    run(&auth, &mut url, &mut headers, &mut b"{}".to_vec());
    let header = headers.get("authorization")[0].to_string();
    assert!(header.starts_with("OAuth realm=\"Photos\","), "{header}");
    // PLAINTEXT is the encoded secrets joined by "&", encoded again in the header.
    assert!(header.contains(
        "oauth_signature=\"kAcSOqF21Fu85e7zjz7ZN2U4ZRhfV3WpwPAoE3Z7kBw%26LswwdoUaIvS8ltyTt5jkRh4J50vUPVVHtR2YPi5kE\""
    ));
    assert!(!header.contains("oauth_version"));

    let (auth, mut url, mut headers, _) = twitter(&[
        ("addParamsToHeader", json!(true)),
        ("includeBodyHash", json!(true)),
    ]);
    headers.delete("content-type");
    run(&auth, &mut url, &mut headers, &mut b"{}".to_vec());
    // Base64 SHA-1 of "{}".
    assert!(
        headers.get("authorization")[0]
            .contains("oauth_body_hash=\"vyGp6PvFo4RvsFtPoIWeCReyIC8%3D\"")
    );
}

#[test]
fn percent_encodes_like_rfc_3986() {
    assert_eq!(percent_encode("a b+c*~!'()"), "a%20b%2Bc%2A~%21%27%28%29");
    assert_eq!(percent_encode("ñ"), "%C3%B1");
}
