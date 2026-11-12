use super::*;
use crate::auth::tests::signed;
use aws_lc_rs::signature::KeyPair;
use serde_json::json;

fn jwt(rows: Value) -> Value {
    json!({"type": "jwt", "jwt": rows})
}

#[test]
fn matches_the_jwt_io_example() {
    let (_, headers) = signed(
        jwt(json!([
            {"key": "algorithm", "value": "HS256"},
            {"key": "secret", "value": "your-256-bit-secret"},
            {"key": "header", "value": "{\"alg\": \"none\", \"typ\": \"JWT\"}"},
            {"key": "payload", "value": "{\"sub\":\"1234567890\",\"name\":\"John Doe\",\"iat\":1516239022}"},
        ])),
        "https://x",
    );
    assert_eq!(
        headers.get("authorization"),
        [
            "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c"
        ]
    );
}

#[test]
fn adds_alg_after_the_header_keys_and_reads_base64_secrets() {
    let (_, headers) = signed(
        jwt(json!([
            {"key": "algorithm", "value": "HS512"},
            {"key": "secret", "value": "c2VjcmV0"},
            {"key": "isSecretBase64Encoded", "value": true},
            {"key": "header", "value": "{\"kid\":\"k1\"}"},
            {"key": "payload", "value": ""},
            {"key": "headerPrefix", "value": ""},
        ])),
        "https://x",
    );
    let token = headers.get("authorization")[0].to_string();
    let parts: Vec<&str> = token.split('.').collect();
    assert_eq!(
        URL_SAFE_NO_PAD.decode(parts[0]).unwrap(),
        br#"{"kid":"k1","alg":"HS512"}"#
    );
    assert_eq!(URL_SAFE_NO_PAD.decode(parts[1]).unwrap(), b"{}");
    let expected = sign_hmac(
        "HS512",
        b"secret",
        format!("{}.{}", parts[0], parts[1]).as_bytes(),
    );
    assert_eq!(URL_SAFE_NO_PAD.decode(parts[2]).unwrap(), expected);
}

#[test]
fn puts_the_token_in_the_query_when_asked() {
    let (url, headers) = signed(
        jwt(json!([
            {"key": "secret", "value": "s"},
            {"key": "addTokenTo", "value": "queryParam"},
            {"key": "queryParamKey", "value": "jwt"},
        ])),
        "https://x/a?jwt=old&keep=1",
    );
    let query = url.query().unwrap();
    assert!(
        query.starts_with("keep=1&jwt=eyJhbGciOiJIUzI1NiJ9."),
        "{query}"
    );
    assert_eq!(headers.get("authorization"), ["Basic old"]);
}

fn pem(label: &str, der: &[u8]) -> String {
    let body = STANDARD.encode(der);
    let lines: Vec<&str> = body
        .as_bytes()
        .chunks(64)
        .map(|line| std::str::from_utf8(line).unwrap())
        .collect();
    format!(
        "-----BEGIN {label}-----\n{}\n-----END {label}-----\n",
        lines.join("\n")
    )
}

#[test]
fn signs_with_ecdsa_keys_that_verify() {
    let rng = SystemRandom::new();
    for (algorithm, signing, verifying) in [
        (
            "ES256",
            &signature::ECDSA_P256_SHA256_FIXED_SIGNING,
            &signature::ECDSA_P256_SHA256_FIXED,
        ),
        (
            "ES384",
            &signature::ECDSA_P384_SHA384_FIXED_SIGNING,
            &signature::ECDSA_P384_SHA384_FIXED,
        ),
        (
            "ES512",
            &signature::ECDSA_P521_SHA512_FIXED_SIGNING,
            &signature::ECDSA_P521_SHA512_FIXED,
        ),
    ] {
        let pkcs8 = signature::EcdsaKeyPair::generate_pkcs8(signing, &rng).unwrap();
        let pair = signature::EcdsaKeyPair::from_pkcs8(signing, pkcs8.as_ref()).unwrap();
        let token = token(
            algorithm,
            Map::new(),
            &json!({"sub": "nexo"}).as_object().unwrap().clone(),
            SigningKey::PrivateKey(&pem("PRIVATE KEY", pkcs8.as_ref())),
        )
        .unwrap();
        let (input, sig) = token.rsplit_once('.').unwrap();
        signature::UnparsedPublicKey::new(verifying, pair.public_key().as_ref())
            .verify(input.as_bytes(), &URL_SAFE_NO_PAD.decode(sig).unwrap())
            .unwrap();
        // A key on another curve is refused.
        let other = if algorithm == "ES256" {
            "ES384"
        } else {
            "ES256"
        };
        let error = super::token(
            other,
            Map::new(),
            &Map::new(),
            SigningKey::PrivateKey(&pem("PRIVATE KEY", pkcs8.as_ref())),
        )
        .unwrap_err();
        assert!(error.to_string().contains("EC private key"), "{error}");
    }
}

#[test]
fn reports_bad_settings_like_postman() {
    let error = |rows: Value| {
        let mut url = url::Url::parse("https://x").unwrap();
        sign(
            &crate::auth::values(&jwt(rows)),
            &mut Outgoing {
                method: "GET",
                url: &mut url,
                headers: &mut crate::transport::HeaderList::default(),
                body: &mut Vec::new(),
                credential_headers: &mut Vec::new(),
            },
        )
        .unwrap_err()
        .to_string()
    };
    assert!(error(json!([{"key": "algorithm", "value": "HS999"}])).contains("invalid algorithm"));
    assert!(error(json!([])).contains("Invalid secret key"));
    assert!(error(json!([{"key": "algorithm", "value": "RS256"}])).contains("Invalid private key"));
    assert!(
        error(json!([{"key": "secret", "value": "s"}, {"key": "payload", "value": "[1]"}]))
            .contains("must be a JSON object")
    );
    assert!(
        error(json!([{"key": "secret", "value": "s"}, {"key": "payload", "value": "{x"}]))
            .contains("not valid JSON")
    );
}
