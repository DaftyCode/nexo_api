//! AWS Signature Version 4, as Postman signs it: postman-runtime `aws4.js` with the `aws4`
//! library it uses. Credentials go in the `Authorization` header, or in the query of a
//! presigned URL ("Add authorization data to: Request URL"). Bruno and Insomnia name the keys
//! `accessKeyId` and `secretAccessKey`.
//!
//! Like Postman, a non-empty body is hashed into `X-Amz-Content-Sha256`, S3 also gets it for an
//! empty body, and paths of services other than S3 are normalized and encoded once more. One
//! difference: presigned URLs of services other than S3 sign the real body hash, which AWS
//! expects, where Postman hashes an empty body.

mod canonical;
mod signing;

use super::{Outgoing, first, flag, percent_encode, text};
use crate::hex;
use aws_lc_rs::{digest, hmac};
use canonical::{canonical_path, canonical_query};
use nexo_domain::{Error, Result};
use serde_json::{Map, Value};
use signing::sign_at;
use std::time::{SystemTime, UNIX_EPOCH};

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
pub(super) fn amz_date(seconds: u64) -> String {
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

#[cfg(test)]
mod tests;
