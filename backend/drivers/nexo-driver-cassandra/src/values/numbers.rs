//! The numbers, dates, times and durations of CQL as text, and back: two's complement integers
//! of any size, decimals with their scale, days counted from 1970, nanoseconds of a day.
use scylla::value::{CqlDate, CqlDecimal, CqlDuration};

/// Days of the Unix epoch in a CQL `date` (2^31 days before it is day 0).
pub(crate) const DATE_EPOCH: i64 = 1 << 31;

/// The calendar date of a day counted from 1970-01-01 (Howard Hinnant's algorithm).
pub(crate) fn civil(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let month = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (yoe + era * 400 + i64::from(month <= 2), month, day)
}
/// The day counted from 1970-01-01 of a calendar date.
pub(crate) fn days_from_civil(year: i64, month: u32, day: u32) -> i64 {
    let year = if month <= 2 { year - 1 } else { year };
    let era = year.div_euclid(400);
    let yoe = year - era * 400;
    let mp = (i64::from(month) + 9) % 12;
    let doy = (153 * mp + 2) / 5 + i64::from(day) - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

pub(crate) fn date_text(date: CqlDate) -> String {
    let (year, month, day) = civil(i64::from(date.0) - DATE_EPOCH);
    format!("{year:04}-{month:02}-{day:02}")
}
pub(crate) fn time_text(nanos: i64) -> String {
    let seconds = nanos / 1_000_000_000;
    let fraction = nanos % 1_000_000_000;
    let text = format!(
        "{:02}:{:02}:{:02}",
        seconds / 3600,
        seconds / 60 % 60,
        seconds % 60
    );
    if fraction == 0 {
        text
    } else {
        format!("{text}.{fraction:09}")
    }
}
pub(crate) fn timestamp_text(millis: i64) -> String {
    let (days, rest) = (millis.div_euclid(86_400_000), millis.rem_euclid(86_400_000));
    let (year, month, day) = civil(days);
    let time = time_text(rest * 1_000_000);
    let time = time.strip_suffix("000000").unwrap_or(&time);
    format!("{year:04}-{month:02}-{day:02}T{time}Z")
}
/// A duration as CQL writes it: `1mo2d3h4m5s6ms7us8ns`, `0s` when empty.
pub(crate) fn duration_text(duration: &CqlDuration) -> String {
    let mut text = String::new();
    if duration.months < 0 || duration.days < 0 || duration.nanoseconds < 0 {
        text.push('-');
    }
    let mut add = |value: i64, unit: &str| {
        if value != 0 {
            text.push_str(&format!("{}{unit}", value.abs()));
        }
    };
    add(i64::from(duration.months) / 12, "y");
    add(i64::from(duration.months) % 12, "mo");
    add(i64::from(duration.days), "d");
    let nanos = duration.nanoseconds.abs();
    add(nanos / 3_600_000_000_000, "h");
    add(nanos / 60_000_000_000 % 60, "m");
    add(nanos / 1_000_000_000 % 60, "s");
    add(nanos / 1_000_000 % 1000, "ms");
    add(nanos / 1000 % 1000, "us");
    add(nanos % 1000, "ns");
    if text.is_empty() || text == "-" {
        "0s".into()
    } else {
        text
    }
}

/// A two's complement big-endian integer as decimal text.
pub(crate) fn bigint_text(bytes: &[u8]) -> String {
    if bytes.is_empty() {
        return "0".into();
    }
    let negative = bytes[0] & 0x80 != 0;
    let mut magnitude: Vec<u8> = if negative {
        // Two's complement back: invert and add one.
        let mut inverted: Vec<u8> = bytes.iter().map(|byte| !byte).collect();
        for byte in inverted.iter_mut().rev() {
            let (sum, carry) = byte.overflowing_add(1);
            *byte = sum;
            if !carry {
                break;
            }
        }
        inverted
    } else {
        bytes.to_vec()
    };
    let mut digits = Vec::new();
    while magnitude.iter().any(|byte| *byte != 0) {
        let mut remainder = 0u32;
        for byte in magnitude.iter_mut() {
            let value = (remainder << 8) | u32::from(*byte);
            *byte = (value / 10) as u8;
            remainder = value % 10;
        }
        digits.push(char::from(b'0' + remainder as u8));
    }
    if digits.is_empty() {
        digits.push('0');
    }
    if negative {
        digits.push('-');
    }
    digits.iter().rev().collect()
}

/// Decimal text as a two's complement big-endian integer.
pub(crate) fn bigint_bytes(text: &str) -> Option<Vec<u8>> {
    let (negative, digits) = match text.strip_prefix('-') {
        Some(rest) => (true, rest),
        None => (false, text.strip_prefix('+').unwrap_or(text)),
    };
    if digits.is_empty() || !digits.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    let mut magnitude = vec![0u8];
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
    // A leading zero byte keeps the sign bit clear.
    if magnitude[0] & 0x80 != 0 {
        magnitude.insert(0, 0);
    }
    if negative {
        for byte in magnitude.iter_mut() {
            *byte = !*byte;
        }
        for byte in magnitude.iter_mut().rev() {
            let (sum, carry) = byte.overflowing_add(1);
            *byte = sum;
            if !carry {
                break;
            }
        }
    }
    while magnitude.len() > 1
        && ((magnitude[0] == 0 && magnitude[1] & 0x80 == 0)
            || (magnitude[0] == 0xff && magnitude[1] & 0x80 != 0))
    {
        magnitude.remove(0);
    }
    Some(magnitude)
}

pub(crate) fn decimal_text(decimal: &CqlDecimal) -> String {
    let (bytes, scale) = decimal.as_signed_be_bytes_slice_and_exponent();
    let digits = bigint_text(bytes);
    if scale <= 0 {
        return format!("{digits}{}", "0".repeat(scale.unsigned_abs() as usize));
    }
    let (sign, digits) = match digits.strip_prefix('-') {
        Some(rest) => ("-", rest.to_owned()),
        None => ("", digits),
    };
    let scale = scale as usize;
    let padded = format!("{digits:0>width$}", width = scale + 1);
    let (whole, fraction) = padded.split_at(padded.len() - scale);
    format!("{sign}{whole}.{fraction}")
}
