//! A simple cron expression: five fields (minute, hour, day of the month, month and day of
//! the week) with `*`, numbers, ranges `a-b`, steps `/n`, lists `a,b` and the English names
//! of months and days (`jan`, `mon`). Seconds, years and `L`, `W` or `#` are not supported.
use super::LocalTime;
use crate::{Error, Result};

const MONTHS: [&str; 12] = [
    "jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec",
];
const DAYS: [&str; 7] = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

/// The times a cron expression matches, one bit per value of each field.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Cron {
    minutes: u64,
    hours: u64,
    days: u64,
    months: u64,
    weekdays: u64,
    /// Restricted fields of the day: when both are, either one matching is enough (as cron).
    any_day: bool,
    any_weekday: bool,
}

fn invalid(detail: &str) -> Error {
    Error::Validation(format!(
        "Write the cron expression as five fields, minute hour day month weekday: {detail}"
    ))
}

/// A number of the field, or a name where the field has them (months from 1, days from 0).
fn number(text: &str, names: &[&str], first: u32) -> Result<u32> {
    if let Ok(value) = text.parse::<u32>() {
        return Ok(value);
    }
    let lower = text.to_ascii_lowercase();
    names
        .iter()
        .position(|name| *name == lower)
        .map(|index| index as u32 + first)
        .ok_or_else(|| invalid(&format!("«{text}» is not a value")))
}

/// The bits of one field. `max` is the largest value; a weekday also accepts 7 for Sunday.
fn field(text: &str, min: u32, max: u32, names: &[&str]) -> Result<u64> {
    let top = if names == DAYS { 7 } else { max };
    let mut bits = 0u64;
    for item in text.split(',') {
        let (range, step) = match item.split_once('/') {
            Some((range, step)) => {
                let step: u32 = step
                    .parse()
                    .ok()
                    .filter(|step| (1..=top).contains(step))
                    .ok_or_else(|| invalid(&format!("«{item}» has an invalid step")))?;
                (range, step)
            }
            None => (item, 1),
        };
        let (from, to) = if range == "*" {
            (min, top)
        } else if let Some((from, to)) = range.split_once('-') {
            (number(from, names, min)?, number(to, names, min)?)
        } else {
            let from = number(range, names, min)?;
            // `5/15` runs from 5 to the end of the field every 15.
            (from, if item.contains('/') { top } else { from })
        };
        if from < min || to > top || from > to {
            return Err(invalid(&format!(
                "«{item}» is outside {min}-{top} or runs backwards"
            )));
        }
        for value in (from..=to).step_by(step as usize) {
            // Sunday is 0 and also 7.
            bits |= 1 << if top != max && value == top { 0 } else { value };
        }
    }
    Ok(bits)
}

impl Cron {
    pub fn parse(text: &str) -> Result<Self> {
        let fields: Vec<&str> = text.split_whitespace().collect();
        let [minute, hour, day, month, weekday] = fields[..] else {
            return Err(invalid(&format!("it has {} fields", fields.len())));
        };
        Ok(Self {
            minutes: field(minute, 0, 59, &[])?,
            hours: field(hour, 0, 23, &[])?,
            days: field(day, 1, 31, &[])?,
            months: field(month, 1, 12, &MONTHS)?,
            weekdays: field(weekday, 0, 6, &DAYS)?,
            any_day: day.starts_with('*'),
            any_weekday: weekday.starts_with('*'),
        })
    }

    /// Whether the expression runs in this minute.
    pub fn matches(&self, time: &LocalTime) -> bool {
        let has = |bits: u64, value: u32| value < 64 && bits & (1 << value) != 0;
        let day = has(self.days, time.day);
        let weekday = has(self.weekdays, time.weekday);
        let day_matches = match (self.any_day, self.any_weekday) {
            (false, false) => day || weekday,
            _ => day && weekday,
        };
        has(self.minutes, time.minute)
            && has(self.hours, time.hour)
            && has(self.months, time.month)
            && day_matches
    }

    /// Whether the day of `time` is one the expression runs on, at any hour.
    pub(super) fn matches_day(&self, time: &LocalTime) -> bool {
        self.matches(&LocalTime {
            minute: self.minutes.trailing_zeros(),
            hour: self.hours.trailing_zeros(),
            ..*time
        })
    }

    /// Whether the hour of `time` is one the expression runs in, on its day.
    pub(super) fn matches_hour(&self, time: &LocalTime) -> bool {
        self.matches(&LocalTime {
            minute: self.minutes.trailing_zeros(),
            ..*time
        })
    }
}
