//! `numeric` and `money` in their binary form, written as exact decimal text.
use super::Decoded;

fn read_i16(buf: &[u8], at: usize) -> Option<i16> {
    Some(i16::from_be_bytes([*buf.get(at)?, *buf.get(at + 1)?]))
}

/// A `numeric`: digits in base 10 000, a weight (the position of the first one) and a scale.
pub(super) fn numeric(buf: &[u8]) -> Decoded<String> {
    let header = (
        read_i16(buf, 0),
        read_i16(buf, 2),
        read_i16(buf, 4),
        read_i16(buf, 6),
    );
    let (Some(count), Some(weight), Some(sign), Some(scale)) = header else {
        return Err("a numeric too short".into());
    };
    let sign = sign as u16;
    match sign {
        0xC000 => return Ok("NaN".into()),
        0xD000 => return Ok("Infinity".into()),
        0xF000 => return Ok("-Infinity".into()),
        _ => {}
    }
    let digits: Vec<i16> = (0..count.max(0) as usize)
        .map(|index| read_i16(buf, 8 + index * 2).ok_or("a numeric too short"))
        .collect::<Result<_, _>>()?;
    let digit = |index: i32| -> i16 {
        usize::try_from(index)
            .ok()
            .and_then(|index| digits.get(index).copied())
            .unwrap_or(0)
    };
    let weight = i32::from(weight);
    let mut text = String::new();
    if sign == 0x4000 {
        text.push('-');
    }
    if weight < 0 {
        text.push('0');
    } else {
        text.push_str(&digit(0).to_string());
        for index in 1..=weight {
            text.push_str(&format!("{:04}", digit(index)));
        }
    }
    let scale = scale.max(0) as usize;
    if scale > 0 {
        let mut fraction = String::new();
        let mut index = weight + 1;
        while fraction.len() < scale {
            fraction.push_str(&format!("{:04}", digit(index)));
            index += 1;
        }
        fraction.truncate(scale);
        text.push('.');
        text.push_str(&fraction);
    }
    Ok(text)
}

/// `money`: cents in an `i64`, written with two decimals (the usual `lc_monetary`).
pub(super) fn money(buf: &[u8]) -> Decoded<String> {
    let cents = i64::from_be_bytes(buf.try_into().map_err(|_| "a money of another size")?);
    let sign = if cents < 0 { "-" } else { "" };
    let cents = cents.unsigned_abs();
    Ok(format!("{sign}{}.{:02}", cents / 100, cents % 100))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The binary form of a numeric from its parts.
    fn encoded(weight: i16, sign: u16, scale: i16, digits: &[i16]) -> Vec<u8> {
        let mut buf = Vec::new();
        for part in [digits.len() as i16, weight, sign as i16, scale] {
            buf.extend_from_slice(&part.to_be_bytes());
        }
        for digit in digits {
            buf.extend_from_slice(&digit.to_be_bytes());
        }
        buf
    }

    #[test]
    fn numerics_keep_every_digit() {
        for (expected, weight, sign, scale, digits) in [
            ("0", 0, 0, 0, &[][..]),
            (
                "12345678901234567890.123456789",
                4,
                0,
                9,
                &[1234, 5678, 9012, 3456, 7890, 1234, 5678, 9000][..],
            ),
            ("-1.50", 0, 0x4000, 2, &[1, 5000][..]),
            ("0.000012", -2, 0, 6, &[1200][..]),
            ("10000", 1, 0, 0, &[1][..]),
            ("42", 0, 0, 0, &[42][..]),
            ("NaN", 0, 0xC000, 0, &[][..]),
            ("-Infinity", 0, 0xF000, 0, &[][..]),
        ] {
            assert_eq!(
                numeric(&encoded(weight, sign, scale, digits)).unwrap(),
                expected
            );
        }
        assert!(numeric(&[0, 1]).is_err());
    }

    #[test]
    fn money_has_two_decimals() {
        assert_eq!(money(&12345i64.to_be_bytes()).unwrap(), "123.45");
        assert_eq!(money(&(-5i64).to_be_bytes()).unwrap(), "-0.05");
    }
}
