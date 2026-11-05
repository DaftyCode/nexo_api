//! AWS Signature Version 4, as Postman signs it: postman-runtime `aws4.js` with the `aws4`
//! library it uses. Credentials go in the `Authorization` header, or in the query of a
//! presigned URL ("Add authorization data to: Request URL"). Bruno and Insomnia name the keys
//! `accessKeyId` and `secretAccessKey`.
//!
//! Like Postman, a non-empty body is hashed into `X-Amz-Content-Sha256`, S3 also gets it for an
//! empty body, and paths of services other than S3 are normalized and encoded once more. One
//! difference: presigned URLs of services other than S3 sign the real body hash, which AWS
//! expects, where Postman hashes an empty body.
use std::time::{SystemTime, UNIX_EPOCH};

use aws_lc_rs::{digest, hmac};
use nexo_domain::{Error, Result};
use serde_json::{Map, Value};

use super::{Outgoing, first, flag, percent_encode, text};

/// Headers that proxies and clients change, which the `aws4` library never signs.
const UNSIGNED: [&str; 7] = [
    "authorization",
    "connection",
    "x-amzn-trace-id",
    "user-agent",
    "expect",
    "presigned-expires",
    "range",
];
/// Query parameters a previous signature left, removed before signing (`X-Amz-Expires` stays,
/// so that it can be chosen).
const SIGNATURE_PARAMETERS: [&str; 6] = [
    "X-Amz-Security-Token",
    "X-Amz-Date",
    "X-Amz-Algorithm",
    "X-Amz-Credential",
    "X-Amz-SignedHeaders",
    "X-Amz-Signature",
];

struct Credentials {
    access_key: String,
    secret_key: String,
    session_token: String,
    service: String,
    region: String,
    to_query: bool,
}

pub fn sign(auth: &Map<String, Value>, request: &mut Outgoing) -> Result<()> {
    let access_key = first(auth, &["accessKey", "accessKeyId"]);
    let secret_key = first(auth, &["secretKey", "secretAccessKey"]);
    if access_key.is_empty() || secret_key.is_empty() {
        if !text(auth.get("profileName")).trim().is_empty() {
            return Err(Error::Validation(
                "AWS Signature: enter the access key and secret key; profiles from ~/.aws are not read"
                    .into(),
            ));
        }
        return Ok(());
    }
    let or = |value: String, default: &str| {
        if value.is_empty() {
            default.to_string()
        } else {
            value
        }
    };
    let credentials = Credentials {
        access_key,
        secret_key,
        session_token: first(auth, &["sessionToken"]),
        service: or(first(auth, &["service"]), "execute-api"),
        region: or(first(auth, &["region"]), "us-east-1"),
        to_query: flag(auth, "addAuthDataToQuery"),
    };
    let seconds = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_secs())
        .unwrap_or_default();
    sign_at(&credentials, request, &amz_date(seconds));
    Ok(())
}

/// `YYYYMMDDTHHMMSSZ` for a time in seconds since 1970 (UTC).
fn amz_date(seconds: u64) -> String {
    let (days, time) = (seconds / 86_400, seconds % 86_400);
    // Days to a civil date (Howard Hinnant's algorithm).
    let z = days as i64 + 719_468;
    let era = z.div_euclid(146_097);
    let day_of_era = z - era * 146_097;
    let year_of_era =
        (day_of_era - day_of_era / 1_460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let shifted_month = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * shifted_month + 2) / 5 + 1;
    let month = if shifted_month < 10 {
        shifted_month + 3
    } else {
        shifted_month - 9
    };
    let year = year_of_era + era * 400 + i64::from(month <= 2);
    format!(
        "{year:04}{month:02}{day:02}T{:02}{:02}{:02}Z",
        time / 3_600,
        time / 60 % 60,
        time % 60
    )
}

fn sha256_hex(data: &[u8]) -> String {
    hex::encode(digest::digest(&digest::SHA256, data))
}

fn hmac_sha256(key: &[u8], data: &str) -> Vec<u8> {
    hmac::sign(&hmac::Key::new(hmac::HMAC_SHA256, key), data.as_bytes())
        .as_ref()
        .to_vec()
}

fn sign_at(credentials: &Credentials, request: &mut Outgoing, datetime: &str) {
    let s3 = credentials.service == "s3";
    for name in [
        "Authorization",
        "X-Amz-Date",
        "X-Amz-Security-Token",
        "X-Amz-Content-Sha256",
    ] {
        request.headers.delete(name);
    }
    let kept: Vec<(String, String)> = request
        .url
        .query_pairs()
        .filter(|(key, _)| !SIGNATURE_PARAMETERS.contains(&key.as_ref()))
        .map(|(key, value)| (key.into_owned(), value.into_owned()))
        .collect();
    let raw_query: Vec<String> = request
        .url
        .query()
        .unwrap_or("")
        .split('&')
        .filter(|pair| {
            let key = pair.split('=').next().unwrap_or("");
            !pair.is_empty() && !SIGNATURE_PARAMETERS.contains(&key)
        })
        .map(str::to_string)
        .collect();

    let scope = format!(
        "{}/{}/{}/aws4_request",
        &datetime[..8],
        credentials.region,
        credentials.service
    );
    let mut added: Vec<(String, String)> = Vec::new();
    if credentials.to_query {
        if !credentials.session_token.is_empty() {
            added.push((
                "X-Amz-Security-Token".into(),
                credentials.session_token.clone(),
            ));
        }
        if s3 && !kept.iter().any(|(key, _)| key == "X-Amz-Expires") {
            added.push(("X-Amz-Expires".into(), "86400".into()));
        }
        added.push(("X-Amz-Date".into(), datetime.into()));
        added.push(("X-Amz-Algorithm".into(), "AWS4-HMAC-SHA256".into()));
        added.push((
            "X-Amz-Credential".into(),
            format!("{}/{scope}", credentials.access_key),
        ));
    } else {
        if !credentials.session_token.is_empty() {
            request
                .headers
                .set("X-Amz-Security-Token", &credentials.session_token);
            request
                .credential_headers
                .push("X-Amz-Security-Token".into());
        }
        if !request.body.is_empty() || s3 {
            request
                .headers
                .set("X-Amz-Content-Sha256", &sha256_hex(request.body));
        }
        request.headers.set("X-Amz-Date", datetime);
    }

    // Signed headers: every header but those clients change, plus Host, sorted by name.
    let mut headers: Vec<(String, String)> = Vec::new();
    for (name, value) in request.headers.iter() {
        let name = name.to_ascii_lowercase();
        if UNSIGNED.contains(&name.as_str()) {
            continue;
        }
        let value = value.split_whitespace().collect::<Vec<_>>().join(" ");
        match headers.iter_mut().find(|(known, _)| *known == name) {
            Some((_, values)) => {
                values.push(',');
                values.push_str(&value);
            }
            None => headers.push((name, value)),
        }
    }
    if !headers.iter().any(|(name, _)| name == "host") {
        let host = request.url.host_str().unwrap_or("").to_string();
        let host = match request.url.port() {
            Some(port) => format!("{host}:{port}"),
            None => host,
        };
        headers.push(("host".into(), host));
    }
    headers.sort_by(|a, b| a.0.cmp(&b.0));
    let signed_headers = headers
        .iter()
        .map(|(name, _)| name.as_str())
        .collect::<Vec<_>>()
        .join(";");
    if credentials.to_query {
        added.push(("X-Amz-SignedHeaders".into(), signed_headers.clone()));
    }

    let payload = if s3 && credentials.to_query {
        "UNSIGNED-PAYLOAD".to_string()
    } else {
        request
            .headers
            .get("x-amz-content-sha256")
            .first()
            .map(|hash| hash.to_string())
            .unwrap_or_else(|| sha256_hex(request.body))
    };
    let mut parameters = kept.clone();
    parameters.extend(added.iter().cloned());
    let canonical = [
        request.method.to_string(),
        canonical_path(request.url.path(), s3),
        canonical_query(&parameters, s3),
        headers
            .iter()
            .map(|(name, value)| format!("{name}:{value}\n"))
            .collect(),
        signed_headers.clone(),
        payload,
    ]
    .join("\n");
    let string_to_sign = format!(
        "AWS4-HMAC-SHA256\n{datetime}\n{scope}\n{}",
        sha256_hex(canonical.as_bytes())
    );
    let mut key = format!("AWS4{}", credentials.secret_key).into_bytes();
    for part in [
        &datetime[..8],
        credentials.region.as_str(),
        credentials.service.as_str(),
        "aws4_request",
    ] {
        key = hmac_sha256(&key, part);
    }
    let signature = hex::encode(hmac_sha256(&key, &string_to_sign));

    if credentials.to_query {
        added.push(("X-Amz-Signature".into(), signature));
        let mut query = raw_query;
        query.extend(
            added
                .iter()
                .filter(|(key, _)| !kept.iter().any(|(known, _)| known == key))
                .map(|(key, value)| format!("{}={}", percent_encode(key), percent_encode(value))),
        );
        request.url.set_query(Some(&query.join("&")));
    } else {
        request.headers.set(
            "Authorization",
            &format!(
                "AWS4-HMAC-SHA256 Credential={}/{scope}, SignedHeaders={signed_headers}, Signature={signature}",
                credentials.access_key
            ),
        );
        request.credential_headers.push("Authorization".into());
    }
}

/// The path as `aws4` signs it: services other than S3 collapse repeated slashes, resolve `.`
/// and `..` and encode the (already encoded) segments again; S3 encodes them once.
fn canonical_path(path: &str, s3: bool) -> String {
    if path == "/" || path.is_empty() {
        return "/".into();
    }
    let mut path = path.to_string();
    if !s3 {
        while path.contains("//") {
            path = path.replace("//", "/");
        }
    }
    let mut segments: Vec<String> = Vec::new();
    for piece in path.split('/') {
        if !s3 && piece == ".." {
            segments.pop();
        } else if s3 || piece != "." {
            let piece = if s3 {
                percent_decode(&piece.replace('+', " "))
            } else {
                piece.to_string()
            };
            segments.push(percent_encode(&piece));
        }
    }
    let mut path = segments.join("/");
    if !path.starts_with('/') {
        path.insert(0, '/');
    }
    if s3 {
        path = path.replace("%2F", "/");
    }
    path
}

fn percent_decode(text: &str) -> String {
    url::form_urlencoded::parse(format!("x={}", text.replace('&', "%26")).as_bytes())
        .next()
        .map(|(_, value)| value.into_owned())
        .unwrap_or_default()
}

/// Parameters encoded and sorted by name, then by value; S3 signs only the first value of a
/// repeated name.
fn canonical_query(parameters: &[(String, String)], s3: bool) -> String {
    let mut names: Vec<(String, Vec<String>)> = Vec::new();
    for (key, value) in parameters {
        if key.is_empty() {
            continue;
        }
        let key = percent_encode(key);
        let value = percent_encode(value);
        match names.iter_mut().find(|(known, _)| *known == key) {
            Some((_, values)) if !s3 => values.push(value),
            Some(_) => {}
            None => names.push((key, vec![value])),
        }
    }
    names.sort_by(|a, b| a.0.cmp(&b.0));
    names
        .into_iter()
        .flat_map(|(key, mut values)| {
            values.sort();
            values
                .into_iter()
                .map(move |value| format!("{key}={value}"))
        })
        .collect::<Vec<_>>()
        .join("&")
}

#[cfg(test)]
mod tests {
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
}
