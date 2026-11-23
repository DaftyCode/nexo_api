//! Ignite's dates and times in a tuple, both ways: a date in 3 bytes (`year << 9 | month << 5
//! | day`), a time in 4 to 6 (milliseconds, microseconds or nanoseconds after the hour,
//! minute and second), a date-time as both, an instant as seconds and nanoseconds since 1970,
//! and a period or a duration as Java writes them (`P1Y2M3D`, `PT1H30M`).

/// The calendar date of a day counted from 1970-01-01 (Howard Hinnant's algorithm).
pub fn civil(days: i64) -> (i64, u32, u32) {
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
pub fn days_from_civil(year: i64, month: u32, day: u32) -> i64 {
    let year = if month <= 2 { year - 1 } else { year };
    let era = year.div_euclid(400);
    let yoe = year - era * 400;
    let mp = (i64::from(month) + 9) % 12;
    let doy = (153 * mp + 2) / 5 + i64::from(day) - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

fn year_text(year: i64) -> String {
    if year < 0 {
        format!("-{:04}", -year)
    } else {
        format!("{year:04}")
    }
}
fn fraction(nanos: u32) -> String {
    match nanos {
        0 => String::new(),
        n if n % 1_000_000 == 0 => format!(".{:03}", n / 1_000_000),
        n if n % 1000 == 0 => format!(".{:06}", n / 1000),
        n => format!(".{n:09}"),
    }
}

pub fn date(bytes: &[u8]) -> Option<String> {
    let [low, high, top] = bytes.try_into().ok()?;
    let packed = i32::from(u16::from_le_bytes([low, high])) | (i32::from(top as i8) << 16);
    let (day, month) = (packed & 31, (packed >> 5) & 15);
    Some(format!(
        "{}-{month:02}-{day:02}",
        year_text(i64::from(packed >> 9))
    ))
}

pub fn time(bytes: &[u8]) -> Option<String> {
    let mut word = [0u8; 8];
    word.get_mut(..bytes.len())?.copy_from_slice(bytes);
    let packed = u64::from_le_bytes(word);
    let (rest, nanos) = match bytes.len() {
        4 => (packed >> 10, (packed & 0x3ff) as u32 * 1_000_000),
        5 => (packed >> 20, (packed & 0xf_ffff) as u32 * 1000),
        6 => (packed >> 30, (packed & 0x3fff_ffff) as u32),
        _ => return None,
    };
    let (hour, minute, second) = ((rest >> 12) & 31, (rest >> 6) & 63, rest & 63);
    Some(format!(
        "{hour:02}:{minute:02}:{second:02}{}",
        fraction(nanos)
    ))
}

pub fn datetime(bytes: &[u8]) -> Option<String> {
    if !(7..=9).contains(&bytes.len()) {
        return None;
    }
    Some(format!("{} {}", date(&bytes[..3])?, time(&bytes[3..])?))
}

fn seconds_and_nanos(bytes: &[u8]) -> Option<(i64, u32)> {
    let seconds = i64::from_le_bytes(bytes.get(..8)?.try_into().ok()?);
    let nanos = match bytes.len() {
        8 => 0,
        12 => u32::from_le_bytes(bytes[8..12].try_into().ok()?),
        _ => return None,
    };
    Some((seconds, nanos))
}

/// An instant, in UTC: `2024-01-02T03:04:05.123Z`.
pub fn instant(bytes: &[u8]) -> Option<String> {
    let (seconds, nanos) = seconds_and_nanos(bytes)?;
    let (days, rest) = (seconds.div_euclid(86_400), seconds.rem_euclid(86_400));
    let (year, month, day) = civil(days);
    Some(format!(
        "{}-{month:02}-{day:02}T{:02}:{:02}:{:02}{}Z",
        year_text(year),
        rest / 3600,
        rest / 60 % 60,
        rest % 60,
        fraction(nanos)
    ))
}

pub fn period(bytes: &[u8]) -> Option<String> {
    let parts: Vec<i64> = match bytes.len() {
        3 => bytes.iter().map(|byte| i64::from(*byte as i8)).collect(),
        6 => bytes
            .as_chunks::<2>()
            .0
            .iter()
            .map(|pair| i64::from(i16::from_le_bytes(*pair)))
            .collect(),
        12 => bytes
            .as_chunks::<4>()
            .0
            .iter()
            .map(|word| i64::from(i32::from_le_bytes(*word)))
            .collect(),
        _ => return None,
    };
    let mut text = String::from("P");
    for (value, unit) in parts.iter().zip(["Y", "M", "D"]) {
        if *value != 0 {
            text.push_str(&format!("{value}{unit}"));
        }
    }
    Some(if text.len() == 1 { "P0D".into() } else { text })
}

pub fn duration(bytes: &[u8]) -> Option<String> {
    let (seconds, nanos) = seconds_and_nanos(bytes)?;
    let total = i128::from(seconds) * 1_000_000_000 + i128::from(nanos);
    let (sign, total) = (if total < 0 { "-" } else { "" }, total.abs());
    let (whole, nanos) = (total / 1_000_000_000, (total % 1_000_000_000) as u32);
    let (hours, minutes, seconds) = (whole / 3600, whole / 60 % 60, whole % 60);
    let mut text = format!("{sign}PT");
    if hours != 0 {
        text.push_str(&format!("{hours}H"));
    }
    if minutes != 0 {
        text.push_str(&format!("{minutes}M"));
    }
    if seconds != 0 || nanos != 0 || text.ends_with('T') {
        let fraction = fraction(nanos);
        text.push_str(&format!("{seconds}{}S", fraction.trim_end_matches('0')));
    }
    Some(text)
}

/// The parts of `HH:MM[:SS[.fraction]]`.
fn parse_time(text: &str) -> Option<(u64, u64, u64, u64)> {
    let mut parts = text.trim().splitn(3, ':');
    let hour: u64 = parts.next()?.parse().ok()?;
    let minute: u64 = parts.next()?.parse().ok()?;
    let (second, nanos) = match parts.next() {
        None => (0, 0),
        Some(rest) => {
            let (whole, fraction) = rest.split_once('.').unwrap_or((rest, ""));
            if fraction.len() > 9 || !fraction.bytes().all(|byte| byte.is_ascii_digit()) {
                return None;
            }
            let nanos = format!("{fraction:0<9}").parse().ok()?;
            (whole.parse().ok()?, nanos)
        }
    };
    (hour < 24 && minute < 60 && second < 60).then_some((hour, minute, second, nanos))
}
/// The parts of `YYYY-MM-DD`, with the sign of a year before 0.
fn parse_date(text: &str) -> Option<(i64, u32, u32)> {
    let text = text.trim();
    let (negative, text) = match text.strip_prefix('-') {
        Some(rest) => (true, rest),
        None => (false, text.strip_prefix('+').unwrap_or(text)),
    };
    let mut parts = text.splitn(3, '-');
    let year: i64 = parts.next()?.parse().ok()?;
    let month: u32 = parts.next()?.parse().ok()?;
    let day: u32 = parts.next()?.parse().ok()?;
    ((1..=12).contains(&month) && (1..=31).contains(&day)).then_some((
        if negative { -year } else { year },
        month,
        day,
    ))
}

pub fn date_bytes(text: &str) -> Option<Vec<u8>> {
    let (year, month, day) = parse_date(text)?;
    let packed = ((year as i32) << 9) | ((month as i32) << 5) | day as i32;
    let mut bytes = (packed as u16).to_le_bytes().to_vec();
    bytes.push((packed >> 16) as u8);
    Some(bytes)
}

pub fn time_bytes(text: &str) -> Option<Vec<u8>> {
    let (hour, minute, second, nanos) = parse_time(text)?;
    let bytes = if nanos % 1000 != 0 {
        let packed = (hour << 42) | (minute << 36) | (second << 30) | nanos;
        packed.to_le_bytes()[..6].to_vec()
    } else if nanos % 1_000_000 != 0 {
        let packed = (hour << 32) | (minute << 26) | (second << 20) | (nanos / 1000);
        packed.to_le_bytes()[..5].to_vec()
    } else {
        let packed = (hour << 22) | (minute << 16) | (second << 10) | (nanos / 1_000_000);
        packed.to_le_bytes()[..4].to_vec()
    };
    Some(bytes)
}

/// `YYYY-MM-DD HH:MM[:SS[.f]]`, with a space or a `T` between the date and the time.
fn split_datetime(text: &str) -> Option<(&str, &str)> {
    let text = text.trim();
    let at = text.get(1..)?.find([' ', 'T'])? + 1;
    Some((&text[..at], &text[at + 1..]))
}

pub fn datetime_bytes(text: &str) -> Option<Vec<u8>> {
    let (date, time) = split_datetime(text)?;
    let mut bytes = date_bytes(date)?;
    bytes.extend(time_bytes(time)?);
    Some(bytes)
}

/// An instant written with its offset (`Z`, `+02:00`), or in UTC without one.
pub fn instant_bytes(text: &str) -> Option<Vec<u8>> {
    let (date, time) = split_datetime(text)?;
    let (time, offset) = match time.find(['Z', 'z', '+', '-']) {
        Some(at) => {
            let (time, zone) = time.split_at(at);
            let offset = match zone {
                "Z" | "z" => 0,
                zone => {
                    let sign = if zone.starts_with('-') { -1 } else { 1 };
                    let (hours, minutes) = zone[1..].split_once(':').unwrap_or((&zone[1..], "0"));
                    sign * (hours.parse::<i64>().ok()? * 3600 + minutes.parse::<i64>().ok()? * 60)
                }
            };
            (time, offset)
        }
        None => (time, 0),
    };
    let (year, month, day) = parse_date(date)?;
    let (hour, minute, second, nanos) = parse_time(time)?;
    let seconds = days_from_civil(year, month, day) * 86_400
        + (hour * 3600 + minute * 60 + second) as i64
        - offset;
    let mut bytes = seconds.to_le_bytes().to_vec();
    if nanos != 0 {
        bytes.extend((nanos as u32).to_le_bytes());
    }
    Some(bytes)
}
