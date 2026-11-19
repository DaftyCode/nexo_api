//! The clock of this computer, in its time zone (`jiff` reads it from the system, and on
//! Windows maps it to the IANA database it carries).
use jiff::{Timestamp, tz::TimeZone};
use nexo_application::ports::Clock;
use nexo_domain::monitor::LocalTime;

pub struct SystemClock;

impl Clock for SystemClock {
    fn now(&self) -> i64 {
        Timestamp::now().as_millisecond()
    }
    fn local(&self, millis: i64) -> LocalTime {
        let instant = Timestamp::from_millisecond(millis).unwrap_or(Timestamp::UNIX_EPOCH);
        // jiff keeps the zone a few minutes: a change of zone while Nexo is open is seen soon.
        let time = instant.to_zoned(TimeZone::system());
        LocalTime {
            minute: time.minute() as u32,
            hour: time.hour() as u32,
            day: time.day() as u32,
            month: time.month() as u32,
            weekday: time.weekday().to_sunday_zero_offset() as u32,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn local_time_follows_the_zone_of_this_computer() {
        let clock = SystemClock;
        let now = clock.now();
        let expected = Timestamp::from_millisecond(now)
            .unwrap()
            .to_zoned(TimeZone::system());
        let local = clock.local(now);
        assert_eq!(local.hour, expected.hour() as u32);
        assert_eq!(local.minute, expected.minute() as u32);
        // 2026-11-19 was a Thursday everywhere at noon UTC.
        let thursday = clock.local(1_795_089_600_000);
        assert!((3..=5).contains(&thursday.weekday));
        assert!((18..=20).contains(&thursday.day) && thursday.month == 11);
    }
}
