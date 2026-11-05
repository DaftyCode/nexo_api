//! Lowercase hexadecimal, for the vault file, hashes and nonces.

const DIGITS: &[u8; 16] = b"0123456789abcdef";

pub fn encode(bytes: impl AsRef<[u8]>) -> String {
    let bytes = bytes.as_ref();
    let mut text = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        text.push(DIGITS[(byte >> 4) as usize] as char);
        text.push(DIGITS[(byte & 0xf) as usize] as char);
    }
    text
}

/// The bytes of hexadecimal text (either case); `None` when it is not hexadecimal.
pub fn decode(text: impl AsRef<[u8]>) -> Option<Vec<u8>> {
    let text = text.as_ref();
    if text.len() % 2 != 0 {
        return None;
    }
    let digit = |c: u8| (c as char).to_digit(16).map(|d| d as u8);
    text.chunks(2)
        .map(|pair| Some(digit(pair[0])? << 4 | digit(pair[1])?))
        .collect()
}

#[cfg(test)]
mod tests {
    #[test]
    fn encodes_and_decodes() {
        assert_eq!(super::encode([0x00, 0x9f, 0xff]), "009fff");
        assert_eq!(super::decode("009FfF"), Some(vec![0x00, 0x9f, 0xff]));
        assert_eq!(super::decode("abc"), None);
        assert_eq!(super::decode("zz"), None);
    }
}
