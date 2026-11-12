use super::*;
use crate::transport::HeaderList;
use aws_lc_rs::{rand::SystemRandom, signature, signature::KeyPair};
use base64::engine::general_purpose::URL_SAFE_NO_PAD;

fn ec_key() -> (Vec<u8>, Vec<u8>) {
    let pkcs8 = signature::EcdsaKeyPair::generate_pkcs8(
        &signature::ECDSA_P256_SHA256_FIXED_SIGNING,
        &SystemRandom::new(),
    )
    .unwrap();
    let pair = signature::EcdsaKeyPair::from_pkcs8(
        &signature::ECDSA_P256_SHA256_FIXED_SIGNING,
        pkcs8.as_ref(),
    )
    .unwrap();
    (pkcs8.as_ref().to_vec(), pair.public_key().as_ref().to_vec())
}

fn send(rows: Value) -> Result<String> {
    let mut url = url::Url::parse("https://x").unwrap();
    let mut headers = HeaderList::default();
    sign(
        &crate::auth::values(&json!({"type": "asap", "asap": rows})),
        &mut Outgoing {
            method: "GET",
            url: &mut url,
            headers: &mut headers,
            body: &mut Vec::new(),
            credential_headers: &mut Vec::new(),
        },
    )?;
    Ok(headers.get("authorization")[0].to_string())
}

fn parts(authorization: &str) -> (Value, Value, String) {
    let token = authorization.strip_prefix("Bearer ").unwrap();
    let segments: Vec<&str> = token.split('.').collect();
    let read = |segment: &str| -> Value {
        serde_json::from_slice(&URL_SAFE_NO_PAD.decode(segment).unwrap()).unwrap()
    };
    (read(segments[0]), read(segments[1]), token.to_string())
}

#[test]
fn signs_a_short_lived_token_like_postman() {
    let (pkcs8, public_key) = ec_key();
    // A PEM pasted without line breaks, as Postman's text field keeps it.
    let flat = pem("PRIVATE KEY", &STANDARD.encode(&pkcs8)).replace('\n', "");
    let rows = json!([
        {"key": "alg", "value": "ES256"},
        {"key": "kid", "value": "nexo/key-1"},
        {"key": "iss", "value": "nexo"},
        {"key": "aud", "value": "jira"},
        {"key": "privateKey", "value": flat},
        {"key": "claims", "value": "{\"scope\":\"read\"}"},
    ]);
    let first = send(rows.clone()).unwrap();
    let (header, payload, token) = parts(&first);
    assert_eq!(header, json!({"alg": "ES256", "kid": "nexo/key-1"}));
    let keys: Vec<&str> = payload
        .as_object()
        .unwrap()
        .keys()
        .map(String::as_str)
        .collect();
    assert_eq!(keys, ["scope", "iat", "iss", "sub", "jti", "aud", "exp"]);
    assert_eq!(payload["sub"], "nexo");
    assert_eq!(payload["aud"], "jira");
    assert_eq!(
        payload["exp"].as_u64().unwrap() - payload["iat"].as_u64().unwrap(),
        3600
    );
    let (input, sig) = token.rsplit_once('.').unwrap();
    signature::UnparsedPublicKey::new(&signature::ECDSA_P256_SHA256_FIXED, public_key)
        .verify(input.as_bytes(), &URL_SAFE_NO_PAD.decode(sig).unwrap())
        .unwrap();
    // Every send has its own token id.
    let (_, again, _) = parts(&send(rows).unwrap());
    assert_ne!(again["jti"], payload["jti"]);
}

#[test]
fn claims_win_and_insomnia_keys_and_data_uris_are_read() {
    let (pkcs8, _) = ec_key();
    let uri = format!(
        "data:application/pkcs8;kid=team%2Fkey;base64,{}",
        STANDARD.encode(&pkcs8)
    );
    let (_, payload, _) = parts(
        &send(json!([
            {"key": "algorithm", "value": "ES256"},
            {"key": "keyId", "value": "team/key"},
            {"key": "issuer", "value": "field-issuer"},
            {"key": "subject", "value": "field-subject"},
            {"key": "audience", "value": "field-audience"},
            {"key": "exp", "value": "60"},
            {"key": "privateKey", "value": uri},
            {"key": "additionalClaims", "value": "{\"iss\":\"claim-issuer\",\"aud\":[\"a\",\"b\"],\"jti\":\"fixed\"}"},
        ]))
        .unwrap(),
    );
    assert_eq!(payload["iss"], "claim-issuer");
    assert_eq!(payload["sub"], "field-subject");
    assert_eq!(payload["aud"], json!(["a", "b"]));
    assert_eq!(payload["jti"], "fixed");
    assert_eq!(
        payload["exp"].as_u64().unwrap() - payload["iat"].as_u64().unwrap(),
        60
    );
}

#[test]
fn reports_missing_claims_bad_keys_and_algorithms() {
    let (pkcs8, _) = ec_key();
    let key = pem("PRIVATE KEY", &STANDARD.encode(&pkcs8));
    let base = |extra: Value| {
        let mut rows = vec![
            json!({"key": "kid", "value": "k"}),
            json!({"key": "iss", "value": "i"}),
            json!({"key": "aud", "value": "a"}),
            json!({"key": "privateKey", "value": key}),
            json!({"key": "alg", "value": "ES256"}),
        ];
        rows.extend(extra.as_array().unwrap().iter().cloned());
        send(Value::Array(rows)).unwrap_err().to_string()
    };
    assert!(base(json!([{"key": "kid", "value": ""}])).contains("required claims missing"));
    assert!(base(json!([{"key": "alg", "value": "HS256"}])).contains("invalid algorithm"));
    assert!(base(json!([{"key": "claims", "value": "{oops"}])).contains("Failed to parse claims"));
    assert!(
        base(
            json!([{"key": "privateKey", "value": "data:application/pkcs8;kid=other;base64,AAAA"}])
        )
        .contains("does not match")
    );
    assert!(base(json!([{"key": "privateKey", "value": "not a key"}])).contains("private key"));
}
