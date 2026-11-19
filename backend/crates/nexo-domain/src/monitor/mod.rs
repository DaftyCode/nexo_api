//! Monitors (`monitor` documents): a collection, or one of its folders, run on a schedule
//! while Nexo is open, with an environment, iteration data and what to do when it fails.
//! The schedule runs at whole minutes of this computer's clock: every N minutes or hours
//! from midnight, or at the times of a simple cron expression.
mod cron;

pub use cron::Cron;

use crate::{Error, Result};
use serde_json::Value;

/// Minutes a monitor can run every: those that divide an hour, so it runs at the same
/// minutes of every hour (every 15: at :00, :15, :30 and :45).
pub const EVERY_MINUTES: [u32; 11] = [1, 2, 3, 4, 5, 6, 10, 12, 15, 20, 30];
/// Hours a monitor can run every: those that divide a day, from midnight.
pub const EVERY_HOURS: [u32; 8] = [1, 2, 3, 4, 6, 8, 12, 24];
/// Iterations of one run of a monitor.
pub const MAX_ITERATIONS: u64 = 1000;
/// Delay between the requests of a run, in milliseconds.
pub const MAX_DELAY: u64 = 60_000;
/// Minutes searched ahead for the next run: about five years.
const SEARCH_LIMIT: usize = 100_000;

/// A minute of this computer's clock. `weekday` counts from Sunday (0).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LocalTime {
    pub minute: u32,
    pub hour: u32,
    pub day: u32,
    pub month: u32,
    pub weekday: u32,
}

/// When a monitor runs.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Schedule {
    /// Every so many minutes from midnight.
    Every(u32),
    Cron(Cron),
}

impl Schedule {
    /// Reads `{"every": 15, "unit": "minutes"}`, `{"every": 2, "unit": "hours"}` or
    /// `{"cron": "0 9 * * mon-fri"}`.
    pub fn read(value: &Value) -> Result<Self> {
        if let Some(cron) = value.get("cron").and_then(Value::as_str) {
            return Cron::parse(cron).map(Self::Cron);
        }
        let every = value.get("every").and_then(Value::as_u64).unwrap_or(0) as u32;
        match value.get("unit").and_then(Value::as_str) {
            Some("minutes") if EVERY_MINUTES.contains(&every) => Ok(Self::Every(every)),
            Some("hours") if EVERY_HOURS.contains(&every) => Ok(Self::Every(every * 60)),
            _ => Err(Error::Validation(
                "A monitor runs every 1, 2, 3, 4, 5, 6, 10, 12, 15, 20 or 30 minutes, every \
                 1, 2, 3, 4, 6, 8, 12 or 24 hours, or on a cron expression"
                    .into(),
            )),
        }
    }

    /// Whether the monitor runs in this minute.
    pub fn due(&self, time: &LocalTime) -> bool {
        match self {
            Self::Every(minutes) => (time.hour * 60 + time.minute).is_multiple_of(*minutes),
            Self::Cron(cron) => cron.matches(time),
        }
    }

    /// The first minute after `minute` (minutes since the Unix epoch) when the monitor runs;
    /// `local` gives the time of this computer at a minute. `None` when it never does, such
    /// as on 30 February.
    pub fn next(&self, minute: i64, local: impl Fn(i64) -> LocalTime) -> Option<i64> {
        let mut candidate = minute + 1;
        for _ in 0..SEARCH_LIMIT {
            let time = local(candidate);
            if self.due(&time) {
                return Some(candidate);
            }
            let Self::Cron(cron) = self else {
                candidate += 1;
                continue;
            };
            // Whole days and hours that cannot match are skipped at once.
            candidate += if !cron.matches_day(&time) {
                i64::from(24 * 60 - time.hour * 60 - time.minute)
            } else if !cron.matches_hour(&time) {
                i64::from(60 - time.minute)
            } else {
                1
            };
        }
        None
    }
}

fn text<'a>(value: &'a Value, field: &str) -> Option<&'a str> {
    value
        .get(field)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|text| !text.is_empty())
}

/// Checks the value of a `monitor` document.
pub fn validate(value: &Value) -> Result<()> {
    if text(value, "collection").is_none() {
        return Err(Error::Validation("Choose the collection to run".into()));
    }
    for field in ["folder", "environment"] {
        if value
            .get(field)
            .is_some_and(|v| !v.is_null() && !v.is_string())
        {
            return Err(Error::Validation(format!("Invalid {field} of the monitor")));
        }
    }
    Schedule::read(value.get("schedule").unwrap_or(&Value::Null))?;
    let within = |field: &str, range: std::ops::RangeInclusive<u64>| {
        value
            .get(field)
            .filter(|v| !v.is_null())
            .is_none_or(|v| v.as_u64().is_some_and(|n| range.contains(&n)))
    };
    if !within("iterations", 1..=MAX_ITERATIONS) {
        return Err(Error::Validation(format!(
            "A monitor runs between 1 and {MAX_ITERATIONS} iterations"
        )));
    }
    if !within("delay", 0..=MAX_DELAY) {
        return Err(Error::Validation(format!(
            "The delay between requests is at most {MAX_DELAY} ms"
        )));
    }
    if value
        .get("data")
        .is_some_and(|v| !v.is_null() && !v.is_array())
    {
        return Err(Error::Validation(
            "The iteration data of a monitor is a JSON array".into(),
        ));
    }
    for flag in ["paused", "notify", "allowChanges"] {
        if value
            .get(flag)
            .is_some_and(|v| !v.is_null() && !v.is_boolean())
        {
            return Err(Error::Validation(format!("Invalid {flag} of the monitor")));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests;
