//! The string formats of JSON Schema that are read from samples and checked by the
//! validator: `date-time` and `date` (RFC 3339), `email`, `uuid` and `uri`.

/// The formats known, the most specific first: what a sample is read as.
pub const FORMATS: [&str; 5] = ["uuid", "date-time", "date", "email", "uri"];

fn digits(text: &str) -> Option<u32> {
    (!text.is_empty() && text.bytes().all(|b| b.is_ascii_digit()))
        .then(|| text.parse().ok())
        .flatten()
}

/// `YYYY-MM-DD`, with a day that the month has.
fn date(text: &str) -> bool {
    let parts: Vec<&str> = text.split('-').collect();
    let [year, month, day] = parts.as_slice() else {
        return false;
    };
    if year.len() != 4 || month.len() != 2 || day.len() != 2 {
        return false;
    }
    let (Some(year), Some(month), Some(day)) = (digits(year), digits(month), digits(day)) else {
        return false;
    };
    let leap = year % 4 == 0 && (year % 100 != 0 || year % 400 == 0);
    let days = match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if leap => 29,
        2 => 28,
        _ => return false,
    };
    (1..=days).contains(&day)
}

/// `HH:MM:SS`, with optional fractions of a second and a zone (`Z` or `±HH:MM`).
fn time(text: &str) -> bool {
    let (clock, zone) = match text.find(['Z', 'z', '+', '-']) {
        Some(at) => text.split_at(at),
        None => return false,
    };
    let zoned = match zone {
        "Z" | "z" => true,
        _ => {
            let offset = &zone[1..];
            offset.len() == 5
                && offset.as_bytes()[2] == b':'
                && digits(&offset[..2]).is_some_and(|hours| hours < 24)
                && digits(&offset[3..]).is_some_and(|minutes| minutes < 60)
        }
    };
    let (clock, fraction) = clock.split_once('.').unwrap_or((clock, "0"));
    let parts: Vec<&str> = clock.split(':').collect();
    zoned
        && digits(fraction).is_some()
        && parts.len() == 3
        && parts.iter().all(|part| part.len() == 2)
        && digits(parts[0]).is_some_and(|hours| hours < 24)
        && digits(parts[1]).is_some_and(|minutes| minutes < 60)
        && digits(parts[2]).is_some_and(|seconds| seconds <= 60)
}

fn date_time(text: &str) -> bool {
    match text.find(['T', 't', ' ']) {
        Some(at) => date(&text[..at]) && time(&text[at + 1..]),
        None => false,
    }
}

fn email(text: &str) -> bool {
    let Some((local, domain)) = text.split_once('@') else {
        return false;
    };
    let labels: Vec<&str> = domain.split('.').collect();
    !local.is_empty()
        && local.len() <= 64
        && !local.contains(char::is_whitespace)
        && !domain.contains('@')
        && labels.len() >= 2
        && labels.iter().all(|label| {
            !label.is_empty()
                && !label.starts_with('-')
                && label.chars().all(|c| c.is_alphanumeric() || c == '-')
        })
}

fn uuid(text: &str) -> bool {
    let groups: Vec<&str> = text.split('-').collect();
    groups.len() == 5
        && groups.iter().map(|group| group.len()).eq([8, 4, 4, 4, 12])
        && groups
            .iter()
            .all(|group| group.bytes().all(|b| b.is_ascii_hexdigit()))
}

/// A URI as RFC 3986 writes it: a scheme, a colon and the rest, without spaces.
fn uri(text: &str) -> bool {
    let Some((scheme, rest)) = text.split_once(':') else {
        return false;
    };
    let mut chars = scheme.chars();
    chars.next().is_some_and(|c| c.is_ascii_alphabetic())
        && chars.all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '-' | '.'))
        && !rest.is_empty()
        && !text.contains(|c: char| c.is_whitespace() || c.is_control())
}

/// Whether a text is of this format; formats not known here are not checked.
pub fn matches(format: &str, text: &str) -> bool {
    match format {
        "date-time" => date_time(text),
        "date" => date(text),
        "email" => email(text),
        "uuid" => uuid(text),
        "uri" => uri(text),
        _ => true,
    }
}

/// The format a sample of text reads as, if any. A URI is only read from addresses with a
/// host (`https://…`), so that ids such as `user:7` are not taken for one.
pub fn format_of(text: &str) -> Option<&'static str> {
    FORMATS.into_iter().find(|format| match *format {
        "uri" => uri(text) && text.contains("://"),
        other => matches(other, text),
    })
}
