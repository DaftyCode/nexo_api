//! Dates, times and intervals in their binary form, written in ISO 8601 (timestamps with
//! time zone in UTC), with `infinity` and `-infinity` as PostgreSQL has them.
use super::Decoded;
use chrono::{Duration, NaiveDate, NaiveDateTime, NaiveTime};
use postgres_protocol::types::{date_from_sql, time_from_sql, timestamp_from_sql};

fn epoch() -> NaiveDateTime {
    NaiveDate::from_ymd_opt(2000, 1, 1)
        .and_then(|date| date.and_hms_opt(0, 0, 0))
        .expect("2000-01-01 is a date")
}

pub(super) fn date(buf: &[u8]) -> Decoded<String> {
    Ok(match date_from_sql(buf)? {
        i32::MAX => "infinity".into(),
        i32::MIN => "-infinity".into(),
        days => (epoch().date() + Duration::days(days.into()))
            .format("%Y-%m-%d")
            .to_string(),
    })
}

fn timestamp_text(micros: i64, zone: &str) -> String {
    match micros {
        i64::MAX => "infinity".into(),
        i64::MIN => "-infinity".into(),
        micros => {
            let moment = epoch() + Duration::microseconds(micros);
            format!("{}{zone}", moment.format("%Y-%m-%dT%H:%M:%S%.f"))
        }
    }
}

pub(super) fn timestamp(buf: &[u8]) -> Decoded<String> {
    Ok(timestamp_text(timestamp_from_sql(buf)?, ""))
}

pub(super) fn timestamptz(buf: &[u8]) -> Decoded<String> {
    let micros = timestamp_from_sql(buf)?;
    let zone = if micros == i64::MAX || micros == i64::MIN {
        ""
    } else {
        "Z"
    };
    Ok(timestamp_text(micros, zone))
}

fn time_text(micros: i64) -> String {
    // 24:00:00 is a valid time of PostgreSQL that chrono has no name for.
    if micros >= 86_400_000_000 {
        return "24:00:00".into();
    }
    let seconds = u32::try_from(micros.div_euclid(1_000_000)).unwrap_or(0);
    let nanos = u32::try_from(micros.rem_euclid(1_000_000) * 1000).unwrap_or(0);
    NaiveTime::from_num_seconds_from_midnight_opt(seconds, nanos)
        .map(|time| time.format("%H:%M:%S%.f").to_string())
        .unwrap_or_default()
}

pub(super) fn time(buf: &[u8]) -> Decoded<String> {
    Ok(time_text(time_from_sql(buf)?))
}

/// A time with its offset: the time, then the zone in seconds west of UTC.
pub(super) fn timetz(buf: &[u8]) -> Decoded<String> {
    let (time, zone) = buf.split_at_checked(8).ok_or("a timetz too short")?;
    let micros = i64::from_be_bytes(time.try_into()?);
    let west = i32::from_be_bytes(zone.try_into()?);
    let east = -west;
    let sign = if east < 0 { '-' } else { '+' };
    let (hours, minutes) = (east.abs() / 3600, east.abs() % 3600 / 60);
    Ok(format!(
        "{}{sign}{hours:02}:{minutes:02}",
        time_text(micros)
    ))
}

/// An interval as PostgreSQL writes it: `1 year 2 mons 3 days 04:05:06.5`.
pub(super) fn interval(buf: &[u8]) -> Decoded<String> {
    if buf.len() != 16 {
        return Err("an interval of another size".into());
    }
    let micros = i64::from_be_bytes(buf[..8].try_into()?);
    let days = i32::from_be_bytes(buf[8..12].try_into()?);
    let months = i32::from_be_bytes(buf[12..].try_into()?);
    let mut parts = Vec::new();
    let unit = |count: i32, one: &str, many: &str| {
        format!("{count} {}", if count.abs() == 1 { one } else { many })
    };
    let (years, months) = (months / 12, months % 12);
    if years != 0 {
        parts.push(unit(years, "year", "years"));
    }
    if months != 0 {
        parts.push(unit(months, "mon", "mons"));
    }
    if days != 0 {
        parts.push(unit(days, "day", "days"));
    }
    if micros != 0 || parts.is_empty() {
        let sign = if micros < 0 { "-" } else { "" };
        let micros = micros.unsigned_abs();
        let (hours, rest) = (micros / 3_600_000_000, micros % 3_600_000_000);
        let (minutes, rest) = (rest / 60_000_000, rest % 60_000_000);
        let (seconds, fraction) = (rest / 1_000_000, rest % 1_000_000);
        let mut clock = format!("{sign}{hours:02}:{minutes:02}:{seconds:02}");
        if fraction > 0 {
            let digits = format!("{fraction:06}");
            clock.push('.');
            clock.push_str(digits.trim_end_matches('0'));
        }
        parts.push(clock);
    }
    Ok(parts.join(" "))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dates_and_times_read_as_iso_8601() {
        assert_eq!(date(&0i32.to_be_bytes()).unwrap(), "2000-01-01");
        assert_eq!(date(&9813i32.to_be_bytes()).unwrap(), "2026-11-13");
        assert_eq!(date(&i32::MAX.to_be_bytes()).unwrap(), "infinity");
        let noon = 12 * 3_600_000_000i64 + 500_000;
        assert_eq!(
            timestamp(&noon.to_be_bytes()).unwrap(),
            "2000-01-01T12:00:00.500"
        );
        assert_eq!(
            timestamptz(&0i64.to_be_bytes()).unwrap(),
            "2000-01-01T00:00:00Z"
        );
        assert_eq!(timestamptz(&i64::MIN.to_be_bytes()).unwrap(), "-infinity");
        assert_eq!(time(&noon.to_be_bytes()).unwrap(), "12:00:00.500");
        assert_eq!(time(&86_400_000_000i64.to_be_bytes()).unwrap(), "24:00:00");
        let mut zoned = noon.to_be_bytes().to_vec();
        zoned.extend_from_slice(&(-3600i32).to_be_bytes());
        assert_eq!(timetz(&zoned).unwrap(), "12:00:00.500+01:00");
    }

    #[test]
    fn intervals_read_as_postgresql_writes_them() {
        let encoded = |micros: i64, days: i32, months: i32| {
            let mut buf = micros.to_be_bytes().to_vec();
            buf.extend_from_slice(&days.to_be_bytes());
            buf.extend_from_slice(&months.to_be_bytes());
            interval(&buf).unwrap()
        };
        assert_eq!(
            encoded(14_706_500_000, 3, 14),
            "1 year 2 mons 3 days 04:05:06.5"
        );
        assert_eq!(encoded(0, 0, 0), "00:00:00");
        assert_eq!(encoded(-60_000_000, 1, 0), "1 day -00:01:00");
    }
}
