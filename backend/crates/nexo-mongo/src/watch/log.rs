//! The event log of a change stream, read by polling as the engine's realtime connections
//! are: numbered events, the most recent 1 000 kept, and a state.
use serde_json::{Value, json};
use std::{
    collections::VecDeque,
    time::{Duration, Instant},
};

/// Events kept for the interface to read; older ones are dropped.
pub(super) const MAX_EVENTS: usize = 1_000;
/// How long a closed change stream is still listed.
pub(super) const CLOSED_TTL: Duration = Duration::from_secs(5 * 60);

pub(super) struct Log {
    state: &'static str,
    events: VecDeque<Value>,
    sequence: u64,
    closed_at: Option<Instant>,
}

fn now_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as u64)
        .unwrap_or(0)
}

impl Log {
    pub(super) fn new() -> Self {
        Self {
            state: "connected",
            events: VecDeque::new(),
            sequence: 0,
            closed_at: None,
        }
    }
    pub(super) fn emit(&mut self, kind: &str, data: Value) {
        self.sequence += 1;
        self.events.push_back(json!({
            "sequence": self.sequence, "type": kind, "data": data, "time": now_millis(),
        }));
        while self.events.len() > MAX_EVENTS {
            self.events.pop_front();
        }
    }
    /// `connecting`, `connected`, `closed` or `error`; an error is not turned into closed.
    pub(super) fn set(&mut self, state: &'static str) {
        if matches!(state, "closed" | "error") {
            self.closed_at.get_or_insert_with(Instant::now);
            if self.state == "error" {
                return;
            }
        }
        self.state = state;
    }
    pub(super) fn state(&self) -> &'static str {
        self.state
    }
    pub(super) fn open(&self) -> bool {
        matches!(self.state, "connecting" | "connected")
    }
    pub(super) fn expired(&self) -> bool {
        self.closed_at
            .is_some_and(|closed| closed.elapsed() > CLOSED_TTL)
    }
    pub(super) fn after(&self, sequence: u64) -> Vec<Value> {
        self.events
            .iter()
            .filter(|event| event["sequence"].as_u64().unwrap_or(0) > sequence)
            .cloned()
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_the_latest_events_numbered_and_an_error_over_closing() {
        let mut log = Log::new();
        for n in 0..MAX_EVENTS + 5 {
            log.emit("insert", json!({ "n": n }));
        }
        let events = log.after(0);
        assert_eq!(events.len(), MAX_EVENTS);
        assert_eq!(events[0]["sequence"], 6);
        assert_eq!(log.after(MAX_EVENTS as u64 + 3).len(), 2);
        assert!(log.open());
        log.set("error");
        log.set("closed");
        assert_eq!(log.state(), "error");
        assert!(!log.open() && !log.expired());
    }
}
