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
use base64::{Engine as _, engine::general_purpose::STANDARD};
use nexo_domain::{Error, Result};
use serde_json::{Map, Value};

use super::{Outgoing, flag, legacy, text};

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

fn utf16le(value: &str) -> Vec<u8> {
    value.encode_utf16().flat_map(u16::to_le_bytes).collect()
}

/// Node's `ascii` encoding: the low byte of each UTF-16 unit.
fn low_bytes(value: &str) -> Vec<u8> {
    value.encode_utf16().map(|unit| unit as u8).collect()
}

fn nt_hash(password: &str) -> [u8; 16] {
    legacy::md4(&utf16le(password))
}

fn lm_hash(password: &str) -> [u8; 16] {
    let mut padded = [0u8; 14];
    for (slot, byte) in padded.iter_mut().zip(low_bytes(&password.to_uppercase())) {
        *slot = byte;
    }
    let mut hash = [0u8; 16];
    hash[..8].copy_from_slice(&legacy::des(&padded[..7], b"KGS!@#$%"));
    hash[8..].copy_from_slice(&legacy::des(&padded[7..], b"KGS!@#$%"));
    hash
}

/// The NTLMv1 response: the challenge encrypted under three parts of the padded hash.
fn v1_response(hash: &[u8; 16], challenge: &[u8]) -> Vec<u8> {
    let mut padded = [0u8; 21];
    padded[..16].copy_from_slice(hash);
    padded
        .chunks(7)
        .flat_map(|key| legacy::des(key, challenge))
        .collect()
}

/// NTLMv1 with extended security (NTLM2 session response): `(LM, NT)` responses.
fn session_responses(
    nt: &[u8; 16],
    server_challenge: &[u8],
    client_challenge: &[u8; 8],
) -> (Vec<u8>, Vec<u8>) {
    let mut lm = client_challenge.to_vec();
    lm.extend([0u8; 16]);
    let session = legacy::md5(&[server_challenge, client_challenge].concat());
    (lm, v1_response(nt, &session[..8]))
}

/// NTLMv2 `(LM, NT)` responses for a time in FILETIME (100 ns since 1601).
fn v2_responses(
    nt: &[u8; 16],
    username: &str,
    domain: &str,
    target_info: &[u8],
    server_challenge: &[u8],
    client_challenge: &[u8; 8],
    filetime: u64,
) -> (Vec<u8>, Vec<u8>) {
    let key = legacy::hmac_md5(
        nt,
        &utf16le(&format!("{}{domain}", username.to_uppercase())),
    );
    let mut lm = legacy::hmac_md5(&key, &[server_challenge, client_challenge].concat()).to_vec();
    lm.extend(client_challenge);
    let mut blob = vec![1, 1, 0, 0, 0, 0, 0, 0];
    blob.extend(filetime.to_le_bytes());
    blob.extend(client_challenge);
    blob.extend([0u8; 4]);
    blob.extend(target_info);
    blob.extend([0u8; 4]);
    let mut nt_response = legacy::hmac_md5(&key, &[server_challenge, &blob].concat()).to_vec();
    nt_response.extend(blob);
    (lm, nt_response)
}

fn now_filetime() -> u64 {
    let millis = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as u64)
        .unwrap_or_default();
    (millis + 11_644_473_600_000) * 10_000
}

fn negotiate_message(domain: &str, workstation: &str) -> String {
    let domain = escape(&domain.to_uppercase()).into_bytes();
    let workstation = escape(&workstation.to_uppercase()).into_bytes();
    let mut flags = TYPE1_FLAGS;
    if domain.is_empty() {
        flags -= NEGOTIATE_OEM_DOMAIN_SUPPLIED;
    }
    let mut message = SIGNATURE.to_vec();
    message.extend(1u32.to_le_bytes());
    message.extend(flags.to_le_bytes());
    let field = |message: &mut Vec<u8>, length: usize, offset: usize| {
        message.extend((length as u16).to_le_bytes());
        message.extend((length as u16).to_le_bytes());
        message.extend((offset as u32).to_le_bytes());
    };
    field(&mut message, domain.len(), 40 + workstation.len());
    field(&mut message, workstation.len(), 40);
    message.extend(VERSION);
    message.extend(&workstation);
    message.extend(&domain);
    format!("NTLM {}", STANDARD.encode(message))
}

struct Challenge {
    flags: u32,
    server_challenge: [u8; 8],
    target_info: Option<Vec<u8>>,
}

fn read_u16(bytes: &[u8], at: usize) -> Option<usize> {
    Some(u16::from_le_bytes(bytes.get(at..at + 2)?.try_into().ok()?) as usize)
}

fn read_u32(bytes: &[u8], at: usize) -> Option<u32> {
    Some(u32::from_le_bytes(bytes.get(at..at + 4)?.try_into().ok()?))
}

/// Reads the challenge (type 2) message of a `WWW-Authenticate: NTLM …` header.
fn challenge_message(header: &str) -> Option<Challenge> {
    let encoded = header.split_once("NTLM ")?.1.trim();
    let bytes = STANDARD.decode(encoded).ok()?;
    if bytes.get(..8)? != SIGNATURE || read_u32(&bytes, 8)? != 2 {
        return None;
    }
    let flags = read_u32(&bytes, 20)?;
    let server_challenge = bytes.get(24..32)?.try_into().ok()?;
    let target_info = if flags & NEGOTIATE_TARGET_INFO != 0 {
        let length = read_u16(&bytes, 40)?;
        let offset = read_u32(&bytes, 44)? as usize;
        Some(bytes.get(offset..offset.checked_add(length)?)?.to_vec())
    } else {
        None
    };
    Some(Challenge {
        flags,
        server_challenge,
        target_info,
    })
}

struct Identity<'a> {
    username: &'a str,
    password: &'a str,
    domain: &'a str,
    workstation: &'a str,
}

fn authenticate_message(
    challenge: &Challenge,
    identity: &Identity,
    client_challenge: &[u8; 8],
    filetime: u64,
) -> String {
    let unicode = challenge.flags & NEGOTIATE_UNICODE != 0;
    let domain = escape(&identity.domain.to_uppercase());
    let workstation = escape(&identity.workstation.to_uppercase());
    let encode = |value: &str| {
        if unicode {
            utf16le(value)
        } else {
            low_bytes(value)
        }
    };
    let (domain_bytes, user_bytes, workstation_bytes) = (
        encode(&domain),
        encode(identity.username),
        encode(&workstation),
    );
    let nt = nt_hash(identity.password);
    let (lm_response, nt_response) = if challenge.flags & NEGOTIATE_EXTENDED_SECURITY != 0 {
        match &challenge.target_info {
            Some(target_info) => v2_responses(
                &nt,
                identity.username,
                &domain,
                target_info,
                &challenge.server_challenge,
                client_challenge,
                filetime,
            ),
            None => session_responses(&nt, &challenge.server_challenge, client_challenge),
        }
    } else {
        (
            v1_response(&lm_hash(identity.password), &challenge.server_challenge),
            v1_response(&nt, &challenge.server_challenge),
        )
    };

    let mut message = SIGNATURE.to_vec();
    message.extend(3u32.to_le_bytes());
    let mut offset = 72;
    let names_length = domain_bytes.len() + user_bytes.len() + workstation_bytes.len();
    let field = |message: &mut Vec<u8>, length: usize, at: usize| {
        message.extend((length as u16).to_le_bytes());
        message.extend((length as u16).to_le_bytes());
        message.extend((at as u32).to_le_bytes());
    };
    field(&mut message, lm_response.len(), offset + names_length);
    field(
        &mut message,
        nt_response.len(),
        offset + names_length + lm_response.len(),
    );
    field(&mut message, domain_bytes.len(), offset);
    offset += domain_bytes.len();
    field(&mut message, user_bytes.len(), offset);
    offset += user_bytes.len();
    field(&mut message, workstation_bytes.len(), offset);
    // No session key.
    field(
        &mut message,
        0,
        72 + names_length + lm_response.len() + nt_response.len(),
    );
    let flags = if unicode {
        TYPE3_FLAGS
    } else {
        TYPE3_FLAGS - NEGOTIATE_UNICODE
    };
    message.extend(flags.to_le_bytes());
    message.extend(VERSION);
    for part in [
        &domain_bytes,
        &user_bytes,
        &workstation_bytes,
        &lm_response,
        &nt_response,
    ] {
        message.extend(part.iter());
    }
    format!("NTLM {}", STANDARD.encode(message))
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
mod tests {
    use super::*;

    /// The values of [MS-NLMP] section 4.2.
    const SERVER: [u8; 8] = [0x01, 0x23, 0x45, 0x67, 0x89, 0xab, 0xcd, 0xef];
    const CLIENT: [u8; 8] = [0xaa; 8];

    fn hex(bytes: &[u8]) -> String {
        crate::hex::encode(bytes)
    }

    #[test]
    fn matches_the_ms_nlmp_ntlm_v1_and_session_examples() {
        assert_eq!(
            hex(&nt_hash("Password")),
            "a4f49c406510bdcab6824ee7c30fd852"
        );
        assert_eq!(
            hex(&lm_hash("Password")),
            "e52cac67419a9a224a3b108f3fa6cb6d"
        );
        assert_eq!(
            hex(&v1_response(&nt_hash("Password"), &SERVER)),
            "67c43011f30298a2ad35ece64f16331c44bdbed927841f94"
        );
        assert_eq!(
            hex(&v1_response(&lm_hash("Password"), &SERVER)),
            "98def7b87f88aa5dafe2df779688a172def11c7d5ccdef13"
        );
        let (lm, nt) = session_responses(&nt_hash("Password"), &SERVER, &CLIENT);
        assert_eq!(hex(&lm), "aaaaaaaaaaaaaaaa00000000000000000000000000000000");
        assert_eq!(hex(&nt), "7537f803ae367128ca458204bde7caf81e97ed2683267232");
    }

    /// The target information of the [MS-NLMP] example: domain "Domain", server "Server".
    fn target_info() -> Vec<u8> {
        let mut info = Vec::new();
        for (id, value) in [(2u16, "Domain"), (1, "Server")] {
            let value = utf16le(value);
            info.extend(id.to_le_bytes());
            info.extend((value.len() as u16).to_le_bytes());
            info.extend(value);
        }
        info.extend([0u8; 4]);
        info
    }

    #[test]
    fn matches_the_ms_nlmp_ntlm_v2_example() {
        let (lm, nt) = v2_responses(
            &nt_hash("Password"),
            "User",
            "Domain",
            &target_info(),
            &SERVER,
            &CLIENT,
            0,
        );
        assert_eq!(hex(&lm), "86c35097ac9cec102554764a57cccc19aaaaaaaaaaaaaaaa");
        assert_eq!(hex(&nt[..16]), "68cd0ab851e51c96aabc927bebef6a1c");
    }

    #[test]
    fn writes_the_negotiate_message_like_node_http_ntlm() {
        let message = STANDARD
            .decode(negotiate_message("corp", "pc-1").trim_start_matches("NTLM "))
            .unwrap();
        assert_eq!(&message[..8], SIGNATURE);
        assert_eq!(read_u32(&message, 12), Some(TYPE1_FLAGS));
        assert_eq!(&message[40..], b"PC-1CORP");
        assert_eq!(read_u32(&message, 20), Some(44));
        let without_domain = STANDARD
            .decode(negotiate_message("", "").trim_start_matches("NTLM "))
            .unwrap();
        assert_eq!(
            read_u32(&without_domain, 12),
            Some(TYPE1_FLAGS - NEGOTIATE_OEM_DOMAIN_SUPPLIED)
        );
        assert_eq!(without_domain.len(), 40);
        assert_eq!(escape("Ñu é"), "%D1u%20%E9");
        assert_eq!(escape("ꙮ"), "%uA66E");
    }

    fn challenge_header(flags: u32, target_info: &[u8]) -> String {
        let mut message = SIGNATURE.to_vec();
        message.extend(2u32.to_le_bytes());
        message.extend([0u8; 8]);
        message.extend(flags.to_le_bytes());
        message.extend(SERVER);
        message.extend([0u8; 8]);
        message.extend((target_info.len() as u16).to_le_bytes());
        message.extend((target_info.len() as u16).to_le_bytes());
        message.extend(56u32.to_le_bytes());
        message.extend(VERSION);
        message.extend(target_info);
        format!("NTLM {}", STANDARD.encode(message))
    }

    #[test]
    fn answers_a_challenge_with_ntlm_v2_and_reads_the_fields_back() {
        let flags = NEGOTIATE_UNICODE | NEGOTIATE_EXTENDED_SECURITY | NEGOTIATE_TARGET_INFO;
        let challenge = challenge_message(&challenge_header(flags, &target_info())).unwrap();
        assert_eq!(challenge.server_challenge, SERVER);
        assert_eq!(challenge.target_info.as_deref(), Some(&target_info()[..]));
        let message = authenticate_message(
            &challenge,
            &Identity {
                username: "User",
                password: "Password",
                domain: "Domain",
                workstation: "",
            },
            &CLIENT,
            0,
        );
        let bytes = STANDARD
            .decode(message.trim_start_matches("NTLM "))
            .unwrap();
        let field = |at: usize| {
            let length = read_u16(&bytes, at).unwrap();
            let offset = read_u32(&bytes, at + 4).unwrap() as usize;
            bytes[offset..offset + length].to_vec()
        };
        assert_eq!(read_u32(&bytes, 8), Some(3));
        assert_eq!(field(28), utf16le("DOMAIN"));
        assert_eq!(field(36), utf16le("User"));
        assert_eq!(hex(&field(20)[..16]), {
            // The domain is upper-cased like Postman does, so the proof differs from the
            // specification example, which keeps "Domain".
            let (_, nt) = v2_responses(
                &nt_hash("Password"),
                "User",
                "DOMAIN",
                &target_info(),
                &SERVER,
                &CLIENT,
                0,
            );
            hex(&nt[..16])
        });
        assert_eq!(read_u32(&bytes, 60), Some(TYPE3_FLAGS));
        // A truncated or foreign message is refused instead of read out of bounds.
        assert!(challenge_message("NTLM AAAA").is_none());
        assert!(challenge_message(&challenge_header(flags, &target_info())[..40]).is_none());
    }

    #[test]
    fn reads_the_domain_from_the_username_like_postman() {
        assert_eq!(split_username("CORP\\ada"), ("ada".into(), "CORP".into()));
        assert_eq!(
            split_username("ada@corp.local"),
            ("ada".into(), "corp.local".into())
        );
        assert_eq!(
            split_username("CORP\\ada@x"),
            ("CORP\\ada@x".into(), String::new())
        );
        assert_eq!(split_username("ada"), ("ada".into(), String::new()));
    }
}
