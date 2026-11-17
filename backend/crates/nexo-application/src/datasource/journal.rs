//! What a session did since its transaction began: its statements, for the log the person
//! reviews before committing, and since when it is open. A session in auto-commit keeps
//! nothing, unless a transaction was begun by hand.
use serde::Serialize;
use serde_json::{Value, json};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

/// Statements a log keeps; the older ones are counted, not kept.
const KEPT: usize = 500;

/// Milliseconds since the Unix epoch, as the interface shows times.
pub(crate) fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |since| since.as_millis() as u64)
}

/// A statement of the open transaction.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Logged {
    pub sql: String,
    /// When it started, in milliseconds since the epoch.
    pub at: u64,
    pub ms: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub affected: Option<u64>,
}

#[derive(Debug)]
pub(crate) struct Journal {
    pub auto_commit: bool,
    /// When the transaction began; `None` while none is open.
    pub since: Option<u64>,
    /// Statements since it began, the ones no longer kept included.
    pub count: usize,
    /// Those that wrote or changed structure: what a rollback would undo.
    pub writes: usize,
    pub entries: Vec<Logged>,
}
impl Default for Journal {
    fn default() -> Self {
        Self {
            auto_commit: true,
            since: None,
            count: 0,
            writes: 0,
            entries: Vec::new(),
        }
    }
}

impl Journal {
    /// Notes a statement that ran: in manual commit, or in a transaction begun by hand.
    pub fn statement(&mut self, sql: &str, took: Duration, affected: Option<u64>, writes: bool) {
        if self.auto_commit && self.since.is_none() {
            return;
        }
        let at = now_ms().saturating_sub(took.as_millis() as u64);
        self.since.get_or_insert(at);
        self.count += 1;
        self.writes += usize::from(writes);
        if self.entries.len() == KEPT {
            self.entries.remove(0);
        }
        self.entries.push(Logged {
            sql: sql.to_owned(),
            at,
            ms: took.as_millis() as u64,
            affected,
        });
    }
    /// What the driver said of the transaction: once it ends, its log starts again.
    pub fn state(&mut self, auto_commit: bool, open: bool) {
        self.auto_commit = auto_commit;
        if open {
            self.since.get_or_insert_with(now_ms);
        } else {
            self.since = None;
            self.count = 0;
            self.writes = 0;
            self.entries.clear();
        }
    }
    /// Something waits for a commit or a rollback.
    pub fn open(&self) -> bool {
        self.since.is_some()
    }
    /// The counter and the start, added to a transaction's state.
    pub fn summary(&self) -> Value {
        json!({"statements": self.count, "writes": self.writes, "since": self.since})
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_the_statements_of_an_open_transaction_until_it_ends() {
        let mut journal = Journal::default();
        journal.statement("SELECT 1", Duration::ZERO, None, false);
        assert!(!journal.open(), "auto-commit keeps nothing");
        journal.state(false, false);
        journal.statement(
            "UPDATE t SET a = 1",
            Duration::from_millis(4),
            Some(2),
            true,
        );
        assert!(journal.open());
        assert_eq!(journal.entries[0].affected, Some(2));
        assert_eq!(journal.summary()["statements"], 1);
        for _ in 0..KEPT {
            journal.statement("SELECT 2", Duration::ZERO, None, false);
        }
        assert_eq!((journal.count, journal.entries.len()), (KEPT + 1, KEPT));
        assert_eq!(journal.writes, 1);
        journal.state(false, false);
        assert!(!journal.open() && journal.entries.is_empty());
        // BEGIN by hand in auto-commit: the driver says it is open.
        journal.state(true, true);
        journal.statement("DELETE FROM t", Duration::ZERO, Some(1), true);
        assert_eq!(journal.count, 1);
    }
}
