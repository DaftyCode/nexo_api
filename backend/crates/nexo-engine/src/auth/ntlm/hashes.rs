//! NTLM and LM hashes and the v1 and v2 responses to a challenge.
use super::*;

pub(super) fn utf16le(value: &str) -> Vec<u8> {
    value.encode_utf16().flat_map(u16::to_le_bytes).collect()
}

/// Node's `ascii` encoding: the low byte of each UTF-16 unit.
pub(super) fn low_bytes(value: &str) -> Vec<u8> {
    value.encode_utf16().map(|unit| unit as u8).collect()
}

pub(super) fn nt_hash(password: &str) -> [u8; 16] {
    legacy::md4(&utf16le(password))
}

pub(super) fn lm_hash(password: &str) -> [u8; 16] {
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
pub(super) fn v1_response(hash: &[u8; 16], challenge: &[u8]) -> Vec<u8> {
    let mut padded = [0u8; 21];
    padded[..16].copy_from_slice(hash);
    padded
        .chunks(7)
        .flat_map(|key| legacy::des(key, challenge))
        .collect()
}

/// NTLMv1 with extended security (NTLM2 session response): `(LM, NT)` responses.
pub(super) fn session_responses(
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
pub(super) fn v2_responses(
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

pub(super) fn now_filetime() -> u64 {
    let millis = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as u64)
        .unwrap_or_default();
    (millis + 11_644_473_600_000) * 10_000
}
