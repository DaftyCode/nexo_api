//! The texts of test data: cut to the length of their column, made unique by their row,
//! filled in from a JSON template, and binary values as Base64.
use super::catalogs::{self, Catalog, Language};
use super::rng::Rng;

/// Bytes as standard Base64, as the drivers read binary values.
pub(super) fn base64(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let n = u32::from(chunk[0]) << 16
            | u32::from(*chunk.get(1).unwrap_or(&0)) << 8
            | u32::from(*chunk.get(2).unwrap_or(&0));
        for at in 0..4 {
            if at <= chunk.len() {
                out.push(char::from(ALPHABET[(n >> (18 - 6 * at) & 63) as usize]));
            } else {
                out.push('=');
            }
        }
    }
    out
}

/// Some characters of a text, never cutting one in two.
pub(super) fn cut(text: String, length: Option<u32>) -> String {
    match length {
        Some(length) if text.chars().count() > length as usize => {
            text.chars().take(length as usize).collect()
        }
        _ => text,
    }
}

/// A text that is unique for its row: the row goes at its end, the text cut to make room.
pub(super) fn unique_text(text: String, row: u64, length: Option<u32>) -> String {
    let suffix = format!("-{}", row + 1);
    let room = length.map(|length| (length as usize).saturating_sub(suffix.len()) as u32);
    match text.split_once('@') {
        // An email stays one: the row before the domain.
        Some((user, domain)) => cut(format!("{user}{}@{domain}", row + 1), length),
        None => format!("{}{suffix}", cut(text, room)),
    }
}

pub(super) fn template(template: &str, row: u64, rng: &mut Rng) -> String {
    let mut out = template.replace("{{row}}", &(row + 1).to_string());
    for (token, catalog) in [
        ("{{uuid}}", Catalog::Uuid),
        ("{{firstName}}", Catalog::FirstName),
        ("{{lastName}}", Catalog::LastName),
        ("{{email}}", Catalog::Email),
        ("{{city}}", Catalog::City),
        ("{{country}}", Catalog::Country),
    ] {
        while out.contains(token) {
            out = out.replacen(token, &catalogs::value(catalog, Language::En, rng), 1);
        }
    }
    while out.contains("{{int}}") {
        out = out.replacen("{{int}}", &rng.below(1_000).to_string(), 1);
    }
    while out.contains("{{word}}") {
        let word: String = (0..6).map(|_| rng.letter(false)).collect();
        out = out.replacen("{{word}}", &word, 1);
    }
    out
}
