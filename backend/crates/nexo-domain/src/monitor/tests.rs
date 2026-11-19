use super::*;
use serde_json::json;

/// 2026-11-16 was a Monday; minutes count from its midnight in a clock without offsets.
fn at(minute: i64) -> LocalTime {
    let day = minute.div_euclid(24 * 60);
    let of_day = minute.rem_euclid(24 * 60) as u32;
    // November 2026 has 30 days, December follows.
    let (month, date) = if day < 15 {
        (11, 16 + day as u32)
    } else {
        (12, day as u32 - 14)
    };
    LocalTime {
        minute: of_day % 60,
        hour: of_day / 60,
        day: date,
        month,
        weekday: (1 + day).rem_euclid(7) as u32,
    }
}
const HOUR: i64 = 60;
const DAY: i64 = 24 * HOUR;

#[test]
fn every_n_minutes_or_hours_runs_from_midnight() {
    let every = |schedule| Schedule::read(&schedule).unwrap();
    let fifteen = every(json!({"every": 15, "unit": "minutes"}));
    assert!(fifteen.due(&at(0)) && fifteen.due(&at(9 * HOUR + 45)));
    assert!(!fifteen.due(&at(9 * HOUR + 50)));
    assert_eq!(fifteen.next(9 * HOUR + 45, at), Some(10 * HOUR));
    let six_hours = every(json!({"every": 6, "unit": "hours"}));
    assert!(six_hours.due(&at(18 * HOUR)) && !six_hours.due(&at(19 * HOUR)));
    assert_eq!(six_hours.next(18 * HOUR, at), Some(DAY));
    let minute = every(json!({"every": 1, "unit": "minutes"}));
    assert_eq!(minute.next(5, at), Some(6));
    for wrong in [
        json!({"every": 7, "unit": "minutes"}),
        json!({"every": 5, "unit": "hours"}),
        json!({"every": 5, "unit": "days"}),
        json!({"every": "5", "unit": "minutes"}),
        json!({}),
    ] {
        assert!(Schedule::read(&wrong).is_err(), "{wrong}");
    }
}

#[test]
fn cron_expressions_run_at_their_minutes() {
    let cron = |text: &str| Cron::parse(text).unwrap();
    let workdays = cron("0 9 * * mon-fri");
    assert!(workdays.matches(&at(9 * HOUR)));
    assert!(!workdays.matches(&at(9 * HOUR + 1)));
    // Saturday 21 November.
    assert!(!workdays.matches(&at(5 * DAY + 9 * HOUR)));
    let schedule = Schedule::Cron(workdays);
    assert_eq!(
        schedule.next(4 * DAY + 9 * HOUR, at),
        Some(7 * DAY + 9 * HOUR)
    );

    let quarters = cron("*/15 8-10 * * *");
    assert!(quarters.matches(&at(10 * HOUR + 45)) && !quarters.matches(&at(11 * HOUR)));
    assert!(cron("5/20 * * * *").matches(&at(45)));
    assert!(!cron("5/20 * * * *").matches(&at(15)));
    assert!(cron("0 0 * * 7").matches(&at(6 * DAY)), "7 is Sunday too");
    assert!(cron("0 0 * * SUN").matches(&at(6 * DAY)));
    assert!(cron("30 12 1 dec *").matches(&at(15 * DAY + 12 * HOUR + 30)));
    // Both day fields restricted: either one matching is enough, as cron does.
    let either = cron("0 0 1 * mon");
    assert!(either.matches(&at(0)) && either.matches(&at(15 * DAY)));
    assert!(!either.matches(&at(DAY)));
    assert!(cron("0,30 * * * *").matches(&at(30)));
    assert_eq!(
        Schedule::Cron(cron("0 0 30 2 *")).next(0, at),
        None,
        "30 February never comes"
    );
    for wrong in [
        "* * * *",
        "60 * * * *",
        "* 24 * * *",
        "* * 0 * *",
        "* * * 13 *",
        "* * * * 8",
        "5-1 * * * *",
        "*/0 * * * *",
        "a * * * *",
        "* * * * funday",
    ] {
        assert!(Cron::parse(wrong).is_err(), "{wrong}");
    }
}

#[test]
fn a_monitor_names_its_collection_and_a_valid_schedule() {
    let monitor = |extra: Value| {
        let mut value = json!({
            "collection": "orders",
            "schedule": {"every": 5, "unit": "minutes"},
        });
        for (key, field) in extra.as_object().unwrap() {
            value[key] = field.clone();
        }
        validate(&value)
    };
    assert!(monitor(json!({})).is_ok());
    assert!(
        monitor(json!({
            "folder": "f1", "environment": "prod", "iterations": 3, "delay": 100,
            "data": [{"id": 1}], "paused": true, "notify": true, "allowChanges": false,
        }))
        .is_ok()
    );
    assert!(monitor(json!({"schedule": {"cron": "0 9 * * *"}})).is_ok());
    for wrong in [
        json!({"collection": ""}),
        json!({"schedule": {"every": 7, "unit": "minutes"}}),
        json!({"schedule": {"cron": "every day"}}),
        json!({"iterations": 0}),
        json!({"iterations": 1001}),
        json!({"delay": 60_001}),
        json!({"data": "rows"}),
        json!({"folder": 3}),
        json!({"paused": "yes"}),
    ] {
        assert!(monitor(wrong.clone()).is_err(), "{wrong}");
    }
}
