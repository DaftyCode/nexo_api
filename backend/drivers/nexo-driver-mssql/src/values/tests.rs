use super::{day, fine, seconds, zoned};
use time::{Date, Month, Time, UtcOffset};

#[test]
fn writes_the_decimals_of_a_second_it_has() {
    assert_eq!(seconds("10:20:30.123456700".into()), "10:20:30.1234567");
    assert_eq!(
        seconds("2026-11-13T10:20:30.000000000+02:00".into()),
        "2026-11-13T10:20:30+02:00"
    );
    assert_eq!(
        seconds("2026-11-13T10:20:30.120000000".into()),
        "2026-11-13T10:20:30.12"
    );
    assert_eq!(seconds("2026-11-13".into()), "2026-11-13");
}

#[test]
fn writes_dates_times_and_offsets_in_iso_8601() {
    let date = Date::from_calendar_date(1, Month::January, 9).unwrap();
    assert_eq!(day(date), "0001-01-09");
    let time = Time::from_hms_nano(7, 5, 3, 120_000_000).unwrap();
    assert_eq!(seconds(fine(time)), "07:05:03.12");
    let moment = date.with_time(time).assume_utc();
    let west = UtcOffset::from_hms(-5, -30, 0).unwrap();
    assert_eq!(
        seconds(zoned(moment.to_offset(west))),
        "0001-01-09T01:35:03.12-05:30"
    );
    assert_eq!(seconds(zoned(moment)), "0001-01-09T07:05:03.12+00:00");
}
