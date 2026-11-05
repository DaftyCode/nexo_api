//! WSSE UsernameToken, as Bruno sends it: `X-WSSE: UsernameToken Username="…",
//! PasswordDigest="…", Nonce="…", Created="…"`, with a new nonce (16 random bytes in hex) and
//! creation time (ISO 8601 with milliseconds) on every send.
//!
//! Like Bruno, the digest is the Base64 of the *hexadecimal* SHA-1 of nonce, time and password,
//! so servers that accept Bruno accept Nexo.
use aws_lc_rs::digest;
use base64::{Engine as _, engine::general_purpose::STANDARD};
use nexo_domain::Result;
use serde_json::{Map, Value};

use super::{Outgoing, text};
use crate::hex;

fn header(username: &str, password: &str, nonce: &str, created: &str) -> String {
    let sha1 = digest::digest(
        &digest::SHA1_FOR_LEGACY_USE_ONLY,
        format!("{nonce}{created}{password}").as_bytes(),
    );
    let digest = STANDARD.encode(hex::encode(sha1));
    format!(
        "UsernameToken Username=\"{username}\", PasswordDigest=\"{digest}\", Nonce=\"{nonce}\", Created=\"{created}\""
    )
}

/// The current UTC time as JavaScript's `toISOString`: `YYYY-MM-DDTHH:MM:SS.mmmZ`.
fn created() -> String {
    let elapsed = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    let compact = super::awsv4::amz_date(elapsed.as_secs());
    format!(
        "{}-{}-{}T{}:{}:{}.{:03}Z",
        &compact[..4],
        &compact[4..6],
        &compact[6..8],
        &compact[9..11],
        &compact[11..13],
        &compact[13..15],
        elapsed.subsec_millis()
    )
}

pub fn sign(auth: &Map<String, Value>, request: &mut Outgoing) -> Result<()> {
    let nonce = hex::encode(crate::vault::rand_bytes::<16>());
    let value = header(
        &text(auth.get("username")),
        &text(auth.get("password")),
        &nonce,
        &created(),
    );
    request.headers.set("X-WSSE", &value);
    request.credential_headers.push("x-wsse".into());
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::auth::tests::signed;
    use serde_json::json;

    #[test]
    fn digests_like_bruno() {
        assert_eq!(
            header(
                "bob",
                "taadtaadpstcsm",
                "d36e316282959a9ed4c89851497a717f",
                "2026-11-05T18:20:31.123Z"
            ),
            "UsernameToken Username=\"bob\", PasswordDigest=\"NTllODAyMDdiYmY4NWNiOGM4YWJjYjRlODU2ZmQwMTRiZTAwYWE4NQ==\", Nonce=\"d36e316282959a9ed4c89851497a717f\", Created=\"2026-11-05T18:20:31.123Z\""
        );
    }

    #[test]
    fn sends_a_fresh_nonce_and_time() {
        let auth = json!({"type": "wsse", "wsse": [
            {"key": "username", "value": "bob"}, {"key": "password", "value": "secret"},
        ]});
        let (_, first) = signed(auth.clone(), "https://x");
        let (_, second) = signed(auth, "https://x");
        let header = first.get("x-wsse")[0].to_string();
        let nonce = |header: &str| header.split("Nonce=\"").nth(1).unwrap()[..32].to_string();
        assert_ne!(nonce(&header), nonce(second.get("x-wsse")[0]));
        let created = header
            .split("Created=\"")
            .nth(1)
            .unwrap()
            .trim_end_matches('"');
        assert_eq!(created.len(), 24, "{created}");
        assert!(created.ends_with('Z') && &created[10..11] == "T" && &created[19..20] == ".");
        // Other credentials stay: WSSE has its own header.
        assert_eq!(first.get("authorization"), ["Basic old"]);
    }
}
