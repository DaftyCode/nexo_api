//! Values of a row as the comparison of data reads them: each one as a canonical text, so
//! that two values are the same when their texts are. Between engines the normalization is
//! declared: numbers without trailing zeros, times with their offset taken to UTC,
//! booleans as 1 and 0, and `CHAR` padding (trailing spaces) left out. Values come as
//! drivers send them: plain JSON, or `{"$t": kind, "v": …}` for what JSON cannot hold.
use super::super::Dialect;
use serde_json::{Map, Value};

/// A number written without a sign of `+`, trailing zeros or a lone point: `5.50` is `5.5`.
pub(super) fn number(text: &str) -> String {
    let text = text.trim().trim_start_matches('+');
    let (sign, digits) = match text.strip_prefix('-') {
        Some(rest) => ("-", rest),
        None => ("", text),
    };
    let digits = match digits.split_once('.') {
        Some((whole, fraction)) => {
            let fraction = fraction.trim_end_matches('0');
            if fraction.is_empty() {
                whole.to_string()
            } else {
                format!("{whole}.{fraction}")
            }
        }
        None => digits.to_string(),
    };
    let digits = digits.trim_start_matches('0');
    let digits = if digits.is_empty() || digits.starts_with('.') {
        format!("0{digits}")
    } else {
        digits.to_string()
    };
    if digits == "0" {
        digits
    } else {
        format!("{sign}{digits}")
    }
}

/// Days since 1970-01-01 of a civil date (Howard Hinnant's algorithm).
fn days(year: i64, month: i64, day: i64) -> i64 {
    let year = if month <= 2 { year - 1 } else { year };
    let era = year.div_euclid(400);
    let of_era = year - era * 400;
    let month = (month + 9) % 12;
    let of_year = (153 * month + 2) / 5 + day - 1;
    let of_era_days = of_era * 365 + of_era / 4 - of_era / 100 + of_year;
    era * 146_097 + of_era_days - 719_468
}

fn civil(days: i64) -> (i64, i64, i64) {
    let days = days + 719_468;
    let era = days.div_euclid(146_097);
    let of_era = days - era * 146_097;
    let year_of_era = (of_era - of_era / 1460 + of_era / 36_524 - of_era / 146_096) / 365;
    let of_year = of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month = (5 * of_year + 2) / 153;
    let day = of_year - (153 * month + 2) / 5 + 1;
    let month = if month < 10 { month + 3 } else { month - 9 };
    (year_of_era + era * 400 + i64::from(month <= 2), month, day)
}

/// A date and time as `YYYY-MM-DD HH:MM:SS[.f]`: `T` as a space, the fraction without
/// trailing zeros and, with an offset (`+02`, `-05:30`, `Z`), taken to UTC.
pub fn timestamp(text: &str) -> String {
    let text = text.trim().replacen('T', " ", 1);
    let (clock, offset) = match text.rfind(['+', '-', 'Z', 'z']) {
        Some(at) if at > 10 => (&text[..at], Some(&text[at..])),
        _ => (text.as_str(), None),
    };
    let clock = clock.trim();
    let (main, fraction) = clock.split_once('.').unwrap_or((clock, ""));
    let fraction = fraction.trim_end_matches('0');
    let minutes = match offset.map(|offset| offset.trim_start_matches(['Z', 'z'])) {
        Some("") | None => 0,
        Some(offset) => {
            let sign = if offset.starts_with('-') { -1 } else { 1 };
            let digits: String = offset[1..].chars().filter(char::is_ascii_digit).collect();
            let hours: i64 = digits.get(..2).and_then(|h| h.parse().ok()).unwrap_or(0);
            let mins: i64 = digits.get(2..4).and_then(|m| m.parse().ok()).unwrap_or(0);
            sign * (hours * 60 + mins)
        }
    };
    let parsed = (|| {
        let (date, time) = main.split_once(' ')?;
        let mut date = date.split('-').map(|part| part.parse::<i64>().ok());
        let (year, month, day) = (date.next()??, date.next()??, date.next()??);
        let mut time = time.split(':').map(|part| part.parse::<i64>().ok());
        let (hour, minute) = (time.next()??, time.next()??);
        let second = time.next().flatten().unwrap_or(0);
        Some((year, month, day, hour, minute, second))
    })();
    let Some((year, month, day, hour, minute, second)) = parsed else {
        return clock.to_string();
    };
    let total = (days(year, month, day) * 1440 + hour * 60 + minute - minutes) * 60 + second;
    let (date, seconds) = (total.div_euclid(86_400), total.rem_euclid(86_400));
    let (year, month, day) = civil(date);
    let main = format!(
        "{year:04}-{month:02}-{day:02} {:02}:{:02}:{:02}",
        seconds / 3600,
        seconds % 3600 / 60,
        seconds % 60
    );
    if fraction.is_empty() {
        main
    } else {
        format!("{main}.{fraction}")
    }
}

/// A JSON document with its keys in order, so that key order does not count.
fn sorted(value: &Value) -> Value {
    match value {
        Value::Object(map) => {
            let mut keys: Vec<&String> = map.keys().collect();
            keys.sort();
            Value::Object(
                keys.into_iter()
                    .map(|key| (key.clone(), sorted(&map[key])))
                    .collect::<Map<_, _>>(),
            )
        }
        Value::Array(items) => Value::Array(items.iter().map(sorted).collect()),
        other => other.clone(),
    }
}

/// The canonical text of a value; `between` engines, with the declared normalization.
pub fn canonical(value: &Value, between: bool) -> String {
    match value {
        Value::Null => "null".into(),
        Value::Bool(flag) if between => format!("n:{}", u8::from(*flag)),
        Value::Bool(flag) => format!("b:{flag}"),
        Value::Number(n) => format!("n:{}", number(&n.to_string())),
        Value::String(text) if between => shared_text(text),
        Value::String(text) => format!("s:{text}"),
        Value::Array(items) => format!(
            "a:[{}]",
            items
                .iter()
                .map(|item| canonical(item, between))
                .collect::<Vec<_>>()
                .join(",")
        ),
        Value::Object(typed) => {
            let kind = typed.get("$t").and_then(Value::as_str).unwrap_or_default();
            let text = match typed.get("v") {
                Some(Value::String(text)) => text.clone(),
                Some(other) => other.to_string(),
                None => return format!("o:{}", sorted(value)),
            };
            match kind {
                "integer" | "decimal" | "float" => format!("n:{}", number(&text)),
                "timestamp" | "timestamptz" => format!("t:{}", timestamp(&text)),
                "uuid" => format!("s:{}", text.to_ascii_lowercase()),
                "json" => match serde_json::from_str::<Value>(&text) {
                    Ok(document) => format!("j:{}", sorted(&document)),
                    Err(_) => format!("s:{text}"),
                },
                "text" if between => shared_text(&text),
                "text" => format!("s:{text}"),
                kind => format!("{kind}:{text}"),
            }
        }
    }
}

/// A text between two engines: without the spaces that pad a `CHAR` and, when it holds a
/// JSON object or list (the JSON of an engine without that type), as that JSON.
fn shared_text(text: &str) -> String {
    let trimmed = text.trim();
    if trimmed.starts_with(['{', '['])
        && let Ok(document @ (Value::Object(_) | Value::Array(_))) =
            serde_json::from_str::<Value>(trimmed)
    {
        return format!("j:{}", sorted(&document));
    }
    format!("s:{}", text.trim_end_matches(' '))
}

/// The bytes of a Base64 text (how drivers send binary values); what is not Base64 is left out.
fn base64(text: &str) -> Vec<u8> {
    const ALPHABET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut bytes = Vec::with_capacity(text.len() * 3 / 4);
    let (mut buffer, mut bits) = (0u32, 0u32);
    for c in text.bytes().filter(|c| *c != b'=') {
        let Some(at) = ALPHABET.iter().position(|letter| *letter == c) else {
            continue;
        };
        buffer = (buffer << 6) | at as u32;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            bytes.push((buffer >> bits) as u8);
            buffer &= (1 << bits) - 1;
        }
    }
    bytes
}

/// A value written as an SQL literal of `dialect`, for a script that is read before it runs.
pub fn literal(value: &Value, dialect: Dialect) -> String {
    let quoted = |text: &str| {
        let text = text.replace('\'', "''");
        if dialect == Dialect::MySql {
            format!("'{}'", text.replace('\\', "\\\\"))
        } else if dialect == Dialect::TSql {
            format!("N'{text}'")
        } else {
            format!("'{text}'")
        }
    };
    match value {
        Value::Null => "NULL".into(),
        Value::Bool(flag) => match dialect {
            Dialect::TSql | Dialect::Sqlite | Dialect::PlSql => u8::from(*flag).to_string(),
            _ => if *flag { "TRUE" } else { "FALSE" }.into(),
        },
        Value::Number(n) => n.to_string(),
        Value::String(text) => quoted(text),
        Value::Array(_) => quoted(&value.to_string()),
        Value::Object(typed) => {
            let kind = typed.get("$t").and_then(Value::as_str).unwrap_or_default();
            let text = match typed.get("v") {
                Some(Value::String(text)) => text.clone(),
                Some(other) => other.to_string(),
                None => value.to_string(),
            };
            match kind {
                "integer" | "decimal" | "float" if text.parse::<f64>().is_ok() => text,
                "binary" => {
                    let bytes = base64(&text);
                    let hex: String = bytes.iter().map(|byte| format!("{byte:02x}")).collect();
                    match dialect {
                        Dialect::PostgreSql => format!("'\\x{hex}'::bytea"),
                        Dialect::TSql | Dialect::Cql => format!("0x{hex}"),
                        _ => format!("X'{hex}'"),
                    }
                }
                // CQL writes a UUID bare.
                "uuid" if dialect == Dialect::Cql => text,
                _ => quoted(&text),
            }
        }
    }
}
