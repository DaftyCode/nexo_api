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
