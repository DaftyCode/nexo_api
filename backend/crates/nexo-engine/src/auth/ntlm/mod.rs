//! NTLM ([MS-NLMP] over HTTP, [MS-NTHT]), as Postman authenticates: postman-runtime `ntlm.js`
//! with its `ntlm-message.js` (from node-http-ntlm).
//!
//! The first request goes without credentials. When the server answers `401`/`403` asking for
//! NTLM (or Negotiate), the request is sent again with a negotiate message (type 1); the server
//! answers with a challenge (type 2), and the request is sent a third time with the
//! authenticate message (type 3). NTLM authenticates the TCP connection, so the transport reads
//! each `401` body to the end to keep the connection open for the next step.
//!
//! NTLMv2 is used when the server negotiates extended security and sends target information,
//! NTLM2 session responses with extended security alone, and NTLMv1 otherwise, as Postman does.
//! MD4, MD5, HMAC-MD5 and DES come from AWS-LC, the library already built for TLS.

mod hashes;
mod messages;

use super::{Outgoing, flag, legacy, text};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use hashes::{
    lm_hash, low_bytes, now_filetime, nt_hash, session_responses, utf16le, v1_response,
    v2_responses,
};
use messages::{Identity, authenticate_message, challenge_message, negotiate_message};
#[cfg(test)]
use messages::{read_u16, read_u32};
use nexo_domain::{Error, Result};
use serde_json::{Map, Value};

const SIGNATURE: &[u8; 8] = b"NTLMSSP\0";
const NEGOTIATE_UNICODE: u32 = 0x0000_0001;
const NEGOTIATE_OEM_DOMAIN_SUPPLIED: u32 = 0x0000_1000;
const NEGOTIATE_EXTENDED_SECURITY: u32 = 0x0008_0000;
const NEGOTIATE_TARGET_INFO: u32 = 0x0080_0000;
/// Unicode, OEM, request target, NTLM, domain and workstation supplied, always sign, extended
/// security, version, 128 and 56 bits.
const TYPE1_FLAGS: u32 = 0xA208_B207;
/// Unicode, request target, NTLM, always sign, extended security, target info, version, 128 and
/// 56 bits: what the type 3 message of node-http-ntlm declares.
const TYPE3_FLAGS: u32 = 0xA288_8205;
/// Windows XP (5.1, build 2600) and NTLM revision 15, as node-http-ntlm writes.
const VERSION: [u8; 8] = [5, 1, 0x28, 0x0A, 0, 0, 0, 15];

fn invalid(message: &str) -> Error {
    Error::Validation(message.into())
}

/// JavaScript's `escape`, which node-http-ntlm applies to the domain and workstation.
fn escape(value: &str) -> String {
    let mut escaped = String::new();
    for unit in value.encode_utf16() {
        match char::from_u32(u32::from(unit)) {
            Some(c) if c.is_ascii_alphanumeric() || "@*_+-./".contains(c) => escaped.push(c),
            _ if unit < 0x100 => escaped.push_str(&format!("%{unit:02X}")),
            _ => escaped.push_str(&format!("%u{unit:04X}")),
        }
    }
    escaped
}

/// `DOMAIN\user` or `user@domain` when no domain is set, as Postman reads the username.
fn split_username(username: &str) -> (String, String) {
    let down_level: Vec<&str> = username.split('\\').collect();
    let principal: Vec<&str> = username.split('@').collect();
    if down_level.len() > 1 && principal.len() > 1 {
        return (username.into(), String::new());
    }
    if let [domain, user] = down_level[..]
        && !domain.is_empty()
        && !user.is_empty()
    {
        return (user.into(), domain.into());
    }
    if let [user, domain] = principal[..]
        && !domain.is_empty()
        && !user.is_empty()
    {
        return (user.into(), domain.into());
    }
    (username.into(), String::new())
}

/// The first request goes without credentials: the server asks for them.
pub fn sign(_auth: &Map<String, Value>, request: &mut Outgoing) -> Result<()> {
    request.headers.delete("Authorization");
    Ok(())
}

/// Answers the server: the negotiate message after its first `401`/`403`, then the
/// authenticate message for its challenge.
pub fn answer(
    auth: &Map<String, Value>,
    round: usize,
    status: u16,
    challenges: &[String],
    request: &mut Outgoing,
) -> Result<bool> {
    if flag(auth, "disableRetryRequest") || !matches!(status, 401 | 403) {
        return Ok(false);
    }
    let mut username = text(auth.get("username"));
    let mut domain = text(auth.get("domain"));
    if domain.is_empty() {
        (username, domain) = split_username(&username);
    }
    let workstation = text(auth.get("workstation"));
    let value = match round {
        0 => {
            let asks = challenges.iter().any(|header| {
                header.eq_ignore_ascii_case("ntlm")
                    || header.eq_ignore_ascii_case("negotiate")
                    || header.contains("NTLM")
            });
            if !asks {
                return Ok(false);
            }
            negotiate_message(&domain, &workstation)
        }
        1 => {
            let header = challenges
                .iter()
                .find(|header| header.starts_with("NTLM "))
                .ok_or_else(|| invalid("ntlm: server did not send NTLM type 2 message"))?;
            let challenge = challenge_message(header).ok_or_else(|| {
                invalid("ntlm: server did not correctly process authentication request")
            })?;
            let password = text(auth.get("password"));
            authenticate_message(
                &challenge,
                &Identity {
                    username: &username,
                    password: &password,
                    domain: &domain,
                    workstation: &workstation,
                },
                &crate::vault::rand_bytes::<8>(),
                now_filetime(),
            )
        }
        _ => return Ok(false),
    };
    request.headers.set("Authorization", &value);
    request.credential_headers.push("Authorization".into());
    Ok(true)
}

#[cfg(test)]
mod tests;
