//! Synthetic values: made-up data of the same form as the real one, always the same for the
//! same value. An email becomes another email at `example.com`, a name field gets names from
//! a list, a date another valid date, a hexadecimal id (an ObjectId, a UUID) another of the
//! same shape, and anything else keeps its punctuation with digits for digits and letters
//! for letters. Numbers keep their digits and sign; typed values of a database keep their
//! type. The generator of test data (DB-27) can use the same lists.
use super::Digest;
use serde_json::{Map, Number, Value};

pub const FIRST_NAMES: [&str; 20] = [
    "Ana", "Luis", "Marta", "Omar", "Lucia", "Pablo", "Sara", "Ivan", "Elena", "Hugo", "Nora",
    "Diego", "Alba", "Mateo", "Irene", "Bruno", "Clara", "Adrian", "Julia", "Samuel",
];
pub const LAST_NAMES: [&str; 20] = [
    "Garcia", "Smith", "Rossi", "Muller", "Silva", "Martin", "Novak", "Kim", "Dubois", "Jensen",
    "Lopez", "Brown", "Costa", "Weber", "Moreau", "Ortiz", "Nakamura", "Ruiz", "Fischer", "Santos",
];

/// Bytes drawn from the keyed hash of a value: as many as a long text needs.
struct Stream<'a> {
    digest: Digest<'a>,
    seed: Vec<u8>,
    block: [u8; 32],
    at: usize,
    counter: u32,
}

impl<'a> Stream<'a> {
    fn new(digest: Digest<'a>, value: &Value) -> Self {
        let seed = value.to_string().into_bytes();
        let block = digest(&seed);
        Self {
            digest,
            seed,
            block,
            at: 0,
            counter: 0,
        }
    }
    fn byte(&mut self) -> u8 {
        if self.at == self.block.len() {
            self.counter += 1;
            let mut input = self.seed.clone();
            input.extend_from_slice(&self.counter.to_be_bytes());
            self.block = (self.digest)(&input);
            self.at = 0;
        }
        self.at += 1;
        self.block[self.at - 1]
    }
    /// A number below `limit` (at most 65,536).
    fn below(&mut self, limit: u32) -> u32 {
        (u32::from(self.byte()) << 8 | u32::from(self.byte())) % limit
    }
    fn digit(&mut self) -> char {
        char::from(b'0' + self.below(10) as u8)
    }
    fn pick<'b>(&mut self, list: &[&'b str]) -> &'b str {
        list[self.below(list.len() as u32) as usize]
    }
}

/// A made-up value in place of `value`, in a field called `name`.
pub fn synthetic(value: &Value, name: &str, digest: Digest) -> Value {
    match value {
        Value::Null => Value::Null,
        Value::Bool(_) => Value::Bool(Stream::new(digest, value).byte() & 1 == 1),
        Value::Number(number) => self::number(number, &mut Stream::new(digest, value)),
        Value::String(text) => {
            Value::String(self::text(text, name, &mut Stream::new(digest, value)))
        }
        Value::Array(items) => Value::Array(
            items
                .iter()
                .map(|item| synthetic(item, name, digest))
                .collect(),
        ),
        Value::Object(fields) => {
            let mut made = Map::new();
            for (key, field) in fields {
                // Typed values keep their type; what they hold is named after their field.
                let value = if key == "$t" {
                    field.clone()
                } else if key == "v" || key.starts_with('$') {
                    synthetic(field, name, digest)
                } else {
                    synthetic(field, key, digest)
                };
                made.insert(key.clone(), value);
            }
            Value::Object(made)
        }
    }
}

/// Digits for digits, the first one not a zero unless it was, up to an exponent.
fn number(number: &Number, stream: &mut Stream) -> Value {
    let mut made = String::new();
    let mut first = true;
    let mut exponent = false;
    for c in number.to_string().chars() {
        exponent |= c == 'e' || c == 'E';
        made.push(if !c.is_ascii_digit() || exponent {
            c
        } else if first && c != '0' {
            char::from(b'1' + stream.below(9) as u8)
        } else {
            stream.digit()
        });
        if c.is_ascii_digit() {
            first = false;
        }
    }
    serde_json::from_str(&made).unwrap_or_else(|_| Value::Number(0.into()))
}

fn text(text: &str, name: &str, stream: &mut Stream) -> String {
    if is_email(text) {
        let first = stream.pick(&FIRST_NAMES).to_lowercase();
        let last = stream.pick(&LAST_NAMES).to_lowercase();
        return format!(
            "{first}.{last}{}{}@example.com",
            stream.digit(),
            stream.digit()
        );
    }
    if let Some(date) = date(text, stream) {
        return date;
    }
    if is_person(name) && text.chars().any(char::is_alphabetic) {
        let surnames = ["last", "surname", "apellido", "family"]
            .iter()
            .any(|word| name.to_lowercase().contains(word));
        return text
            .split_whitespace()
            .enumerate()
            .map(|(at, _)| {
                stream.pick(if at == 0 && !surnames {
                    &FIRST_NAMES
                } else {
                    &LAST_NAMES
                })
            })
            .collect::<Vec<_>>()
            .join(" ");
    }
    let hex = text.len() >= 8
        && text.chars().all(|c| c.is_ascii_hexdigit() || c == '-')
        && text.chars().any(|c| c.is_ascii_digit());
    text.chars()
        .map(|c| match c {
            _ if hex && c.is_ascii_hexdigit() => {
                let digit = char::from_digit(stream.below(16), 16).unwrap_or('0');
                if c.is_ascii_uppercase() {
                    digit.to_ascii_uppercase()
                } else {
                    digit
                }
            }
            _ if c.is_ascii_digit() => stream.digit(),
            _ if c.is_alphabetic() && c.is_uppercase() => char::from(b'A' + stream.below(26) as u8),
            _ if c.is_alphabetic() => char::from(b'a' + stream.below(26) as u8),
            _ => c,
        })
        .collect()
}

fn is_email(text: &str) -> bool {
    let mut parts = text.split('@');
    match (parts.next(), parts.next(), parts.next()) {
        (Some(local), Some(domain), None) => {
            !local.is_empty()
                && domain.contains('.')
                && !domain.starts_with('.')
                && !text.contains(char::is_whitespace)
        }
        _ => false,
    }
}

/// Whether a field holds a person's name (`name`, `firstName`, `apellido`), and not that
/// of a file, a host or a path.
fn is_person(name: &str) -> bool {
    let name = name.to_lowercase();
    ["name", "nombre", "apellido", "surname"]
        .iter()
        .any(|word| name.contains(word))
        && ![
            "file", "host", "path", "domain", "class", "type", "table", "column",
        ]
        .iter()
        .any(|word| name.contains(word))
}

/// Another valid date (`YYYY-MM-DD`, between 1950 and 2009), with a valid time when it has
/// one (`T10:20:30`); the rest (fractions, time zone) is kept.
fn date(text: &str, stream: &mut Stream) -> Option<String> {
    let bytes = text.as_bytes();
    let digits =
        |range: std::ops::Range<usize>| range.into_iter().all(|at| bytes[at].is_ascii_digit());
    if bytes.len() < 10
        || !digits(0..4)
        || bytes[4] != b'-'
        || !digits(5..7)
        || bytes[7] != b'-'
        || !digits(8..10)
    {
        return None;
    }
    let mut made = format!(
        "{:04}-{:02}-{:02}",
        1950 + stream.below(60),
        1 + stream.below(12),
        1 + stream.below(28)
    );
    let mut rest = &text[10..];
    let time = rest.len() >= 9
        && matches!(bytes[10], b'T' | b' ')
        && digits(11..13)
        && bytes[13] == b':'
        && digits(14..16)
        && bytes[16] == b':'
        && digits(17..19);
    if time {
        made.push(char::from(bytes[10]));
        made.push_str(&format!(
            "{:02}:{:02}:{:02}",
            stream.below(24),
            stream.below(60),
            stream.below(60)
        ));
        rest = &text[19..];
    }
    made.push_str(rest);
    Some(made)
}
