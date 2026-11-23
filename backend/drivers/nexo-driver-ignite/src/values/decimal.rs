//! Ignite's decimals in a tuple: the scale as a little-endian `i16`, then the unscaled value as
//! Java's `BigInteger` writes it (big-endian two's complement). Any precision, both ways,
//! without a crate of big numbers.

/// The digits of a big-endian two's-complement integer, with its sign.
fn integer_text(bytes: &[u8]) -> String {
    let negative = bytes.first().is_some_and(|first| first & 0x80 != 0);
    let mut magnitude: Vec<u8> = bytes.to_vec();
    if negative {
        negate(&mut magnitude);
    }
    // Repeated division by 10^9, from the most significant byte.
    let mut chunks = Vec::new();
    while magnitude.iter().any(|byte| *byte != 0) {
        let mut remainder: u64 = 0;
        for byte in magnitude.iter_mut() {
            let current = (remainder << 8) | u64::from(*byte);
            *byte = (current / 1_000_000_000) as u8;
            remainder = current % 1_000_000_000;
        }
        chunks.push(remainder as u32);
        let leading = magnitude.iter().take_while(|byte| **byte == 0).count();
        magnitude.drain(..leading);
    }
    let mut text = match chunks.pop() {
        Some(first) => first.to_string(),
        None => "0".into(),
    };
    for chunk in chunks.iter().rev() {
        text.push_str(&format!("{chunk:09}"));
    }
    if negative { format!("-{text}") } else { text }
}

/// Two's complement in place: inverts the bits and adds one.
fn negate(bytes: &mut [u8]) {
    let mut carry = true;
    for byte in bytes.iter_mut().rev() {
        let (sum, overflow) = (!*byte).overflowing_add(u8::from(carry));
        *byte = sum;
        carry = carry && overflow;
    }
}

/// A decimal as text, at the column's scale when it has one: `1.50` in a `DECIMAL(5, 2)`.
pub fn text(bytes: &[u8], column_scale: i64) -> Option<String> {
    let scale = i64::from(i16::from_le_bytes(bytes.get(..2)?.try_into().ok()?));
    let digits = integer_text(&bytes[2..]);
    let (sign, digits) = match digits.strip_prefix('-') {
        Some(rest) => ("-", rest.to_owned()),
        None => ("", digits),
    };
    let shown = if column_scale >= 0 && column_scale > scale {
        column_scale
    } else {
        scale.max(0)
    };
    // The unscaled digits times 10^(shown − scale): zeros to the right.
    let mut digits = digits + &"0".repeat((shown - scale).max(0) as usize);
    if shown == 0 {
        return Some(format!("{sign}{digits}"));
    }
    let shown = shown as usize;
    if digits.len() <= shown {
        digits = "0".repeat(shown - digits.len() + 1) + &digits;
    }
    let (whole, fraction) = digits.split_at(digits.len() - shown);
    Some(format!("{sign}{whole}.{fraction}"))
}

/// The scale and the bytes of a decimal written as text (`-12.50`, `1e3`).
pub fn bytes(text: &str) -> Option<(i16, Vec<u8>)> {
    let text = text.trim();
    let (number, exponent) = match text.find(['e', 'E']) {
        Some(at) => (&text[..at], text[at + 1..].parse::<i64>().ok()?),
        None => (text, 0),
    };
    let (negative, number) = match number.strip_prefix('-') {
        Some(rest) => (true, rest),
        None => (false, number.strip_prefix('+').unwrap_or(number)),
    };
    let (whole, fraction) = number.split_once('.').unwrap_or((number, ""));
    let digits = format!("{whole}{fraction}");
    if digits.is_empty() || !digits.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    let scale = i16::try_from(fraction.len() as i64 - exponent).ok()?;
    // The digits in base 256, most significant byte first.
    let mut magnitude: Vec<u8> = vec![0];
    for digit in digits.bytes() {
        let mut carry = u32::from(digit - b'0');
        for byte in magnitude.iter_mut().rev() {
            let value = u32::from(*byte) * 10 + carry;
            *byte = value as u8;
            carry = value >> 8;
        }
        while carry > 0 {
            magnitude.insert(0, carry as u8);
            carry >>= 8;
        }
    }
    let leading = magnitude.iter().take_while(|byte| **byte == 0).count();
    magnitude.drain(..leading.min(magnitude.len() - 1));
    // A positive value keeps its top bit clear; a negative one, set.
    if magnitude[0] & 0x80 != 0 {
        magnitude.insert(0, 0);
    }
    if negative && magnitude.iter().any(|byte| *byte != 0) {
        negate(&mut magnitude);
    }
    Some((scale, magnitude))
}

/// The element of a decimal in a tuple.
pub fn element(text: &str) -> Option<(i16, Vec<u8>)> {
    let (scale, unscaled) = bytes(text)?;
    let mut element = scale.to_le_bytes().to_vec();
    element.extend(unscaled);
    Some((scale, element))
}
