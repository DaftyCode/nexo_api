//! The three NTLM messages: negotiate, the server challenge and authenticate.
use super::*;

pub(super) fn negotiate_message(domain: &str, workstation: &str) -> String {
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

pub(super) struct Challenge {
    pub(super) flags: u32,
    pub(super) server_challenge: [u8; 8],
    pub(super) target_info: Option<Vec<u8>>,
}

pub(super) fn read_u16(bytes: &[u8], at: usize) -> Option<usize> {
    Some(u16::from_le_bytes(bytes.get(at..at + 2)?.try_into().ok()?) as usize)
}

pub(super) fn read_u32(bytes: &[u8], at: usize) -> Option<u32> {
    Some(u32::from_le_bytes(bytes.get(at..at + 4)?.try_into().ok()?))
}

/// Reads the challenge (type 2) message of a `WWW-Authenticate: NTLM …` header.
pub(super) fn challenge_message(header: &str) -> Option<Challenge> {
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

pub(super) struct Identity<'a> {
    pub(super) username: &'a str,
    pub(super) password: &'a str,
    pub(super) domain: &'a str,
    pub(super) workstation: &'a str,
}

pub(super) fn authenticate_message(
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
