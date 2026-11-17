//! Dates, times and intervals in their binary form, written in ISO 8601 (timestamps with
//! time zone in UTC), with `infinity` and `-infinity` as PostgreSQL has them.
use super::Decoded;
use postgres_protocol::types::{date_from_sql, time_from_sql, timestamp_from_sql};

const MICROS_A_DAY: i64 = 86_400_000_000;
/// The days from 1970-01-01, where the calendar below counts from, to 2000-01-01, where
/// PostgreSQL does.
const POSTGRES_EPOCH: i64 = 10_957;

/// The day of the proleptic Gregorian calendar some days after 1970-01-01 (Howard Hinnant's
/// `civil_from_days`): exact for every day PostgreSQL keeps, which go beyond what date
/// libraries take.
fn civil(days: i64) -> (i64, i64, i64) {
    let shifted = days + 719_468;
    let era = shifted.div_euclid(146_097);
    let of_era = shifted.rem_euclid(146_097);
    let year_of_era = (of_era - of_era / 1460 + of_era / 36_524 - of_era / 146_096) / 365;
    let of_year = of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_from_march = (5 * of_year + 2) / 153;
    let day = of_year - (153 * month_from_march + 2) / 5 + 1;
    let month = if month_from_march < 10 {
        month_from_march + 3
    } else {
        month_from_march - 9
    };
    let year = year_of_era + era * 400 + i64::from(month <= 2);
    (year, month, day)
}

/// `YYYY-MM-DD`; a year before 1 or after 9999 with its sign, as ISO 8601 extends it.
fn day_text(days: i64) -> String {
    let (year, month, day) = civil(POSTGRES_EPOCH + days);
    let year = match year {
        0..=9999 => format!("{year:04}"),
        _ if year < 0 => format!("-{:04}", year.unsigned_abs()),
        _ => format!("+{year}"),
    };
    format!("{year}-{month:02}-{day:02}")
}

/// `HH:MM:SS`, with the decimals of a second in groups of three, only when it has them.
fn clock(micros: i64) -> String {
    let (seconds, fraction) = (micros / 1_000_000, micros % 1_000_000);
    let text = format!(
        "{:02}:{:02}:{:02}",
        seconds / 3600,
        seconds % 3600 / 60,
        seconds % 60
    );
    match fraction {
        0 => text,
        _ if fraction % 1000 == 0 => format!("{text}.{:03}", fraction / 1000),
        _ => format!("{text}.{fraction:06}"),
    }
}

pub(super) fn date(buf: &[u8]) -> Decoded<String> {
    Ok(match date_from_sql(buf)? {
        i32::MAX => "infinity".into(),
        i32::MIN => "-infinity".into(),
        days => day_text(days.into()),
    })
}

fn timestamp_text(micros: i64, zone: &str) -> String {
    match micros {
        i64::MAX => "infinity".into(),
        i64::MIN => "-infinity".into(),
        micros => format!(
            "{}T{}{zone}",
            day_text(micros.div_euclid(MICROS_A_DAY)),
            clock(micros.rem_euclid(MICROS_A_DAY))
        ),
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

/// A time of the day; 24:00:00 is one too in PostgreSQL.
fn time_text(micros: i64) -> String {
    clock(micros.clamp(0, MICROS_A_DAY))
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
    fn every_day_postgresql_keeps_has_its_calendar_date() {
        let day = |days: i32| date(&days.to_be_bytes()).unwrap();
        assert_eq!(day(-1), "1999-12-31");
        assert_eq!(day(59), "2000-02-29");
        assert_eq!(day(-36_465), "1900-03-01");
        assert_eq!(day(2_903_040), "9948-04-03");
        assert_eq!(day(2_914_635), "9980-01-01");
        assert_eq!(day(2_921_940), "+10000-01-01");
        assert_eq!(day(-730_485), "0000-01-01");
        assert_eq!(day(-730_486), "-0001-12-31");
        // PostgreSQL's last date, far beyond what date libraries take.
        assert_eq!(day(2_145_031_948), "+5874897-12-31");
        let stamp = |micros: i64| timestamp(&micros.to_be_bytes()).unwrap();
        assert_eq!(stamp(-1), "1999-12-31T23:59:59.999999");
        assert_eq!(stamp(1_000), "2000-01-01T00:00:00.001");
        assert_eq!(
            stamp(9_223_371_331_199_999_999),
            "+294276-12-31T23:59:59.999999"
        );
        assert_eq!(time(&(-5i64).to_be_bytes()).unwrap(), "00:00:00");
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
