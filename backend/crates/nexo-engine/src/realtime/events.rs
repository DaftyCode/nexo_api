//! The event log of a connection, which clients read by polling.
use super::*;

pub(super) fn now_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[derive(Default)]
pub(super) struct Log {
    pub(super) state: String,
    pub(super) events: VecDeque<Value>,
    pub(super) sequence: u64,
    pub(super) closed_at: Option<Instant>,
}
/// Event log of one connection, shared with the task that runs it.
#[derive(Clone)]
pub(super) struct Events(pub(super) Arc<Mutex<Log>>);
impl Events {
    pub(super) fn emit(&self, kind: &str, data: Value) {
        let mut log = self.0.lock().unwrap_or_else(|e| e.into_inner());
        log.sequence += 1;
        let sequence = log.sequence;
        log.events.push_back(
            json!({"sequence": sequence, "type": kind, "data": data, "time": now_millis()}),
        );
        while log.events.len() > MAX_EVENTS {
            log.events.pop_front();
        }
    }
    pub(super) fn set(&self, state: &str) {
        let mut log = self.0.lock().unwrap_or_else(|e| e.into_inner());
        if state == "closed" || state == "error" {
            log.closed_at.get_or_insert_with(Instant::now);
            if log.state == "error" && state == "closed" {
                return;
            }
        }
        log.state = state.to_string();
    }
    pub(super) fn state(&self) -> String {
        self.0
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .state
            .clone()
    }
    pub(super) fn open(&self) -> bool {
        matches!(self.state().as_str(), "connecting" | "connected")
    }
    pub(super) fn expired(&self) -> bool {
        let log = self.0.lock().unwrap_or_else(|e| e.into_inner());
        log.closed_at
            .is_some_and(|closed| closed.elapsed() > CLOSED_SESSION_TTL)
    }
}
