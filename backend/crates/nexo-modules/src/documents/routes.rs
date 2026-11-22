//! Which driver connection holds each cursor, running query and change stream.
use std::{
    collections::HashMap,
    sync::{Mutex, PoisonError},
};

/// Names remembered at once; the oldest are forgotten first (their cursors closed long ago).
const NAMES: usize = 512;

#[derive(Default)]
pub(super) struct Routes {
    /// Each name with its connection, in the order they were learned.
    names: Mutex<Vec<(String, String)>>,
    /// Change streams open on each connection.
    watches: Mutex<HashMap<String, usize>>,
}

impl Routes {
    pub fn learn(&self, id: &str, session: &str) {
        let mut names = self.names.lock().unwrap_or_else(PoisonError::into_inner);
        names.retain(|(known, _)| known != id);
        if names.len() >= NAMES {
            names.remove(0);
        }
        names.push((id.to_owned(), session.to_owned()));
    }
    pub fn forget(&self, id: &str) {
        let mut names = self.names.lock().unwrap_or_else(PoisonError::into_inner);
        names.retain(|(known, _)| known != id);
    }
    pub fn of(&self, id: &str) -> Option<String> {
        let names = self.names.lock().unwrap_or_else(PoisonError::into_inner);
        names
            .iter()
            .find(|(known, _)| known == id)
            .map(|(_, session)| session.clone())
    }

    /// A change stream opened on a connection; whether it is the first one.
    pub fn watch(&self, id: &str, session: &str) -> bool {
        self.learn(id, session);
        let mut watches = self.watches.lock().unwrap_or_else(PoisonError::into_inner);
        let count = watches.entry(session.to_owned()).or_default();
        *count += 1;
        *count == 1
    }
    /// A change stream closed; the connection it was on when it was the last one there.
    pub fn unwatch(&self, id: &str) -> Option<String> {
        let session = self.of(id)?;
        self.forget(id);
        let mut watches = self.watches.lock().unwrap_or_else(PoisonError::into_inner);
        let count = watches.get_mut(&session)?;
        *count = count.saturating_sub(1);
        (*count == 0).then(|| {
            watches.remove(&session);
            session
        })
    }
    pub fn watching(&self, session: &str) -> bool {
        let watches = self.watches.lock().unwrap_or_else(PoisonError::into_inner);
        watches.get(session).is_some_and(|count| *count > 0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_lead_to_their_connection_and_watches_hold_it() {
        let routes = Routes::default();
        routes.learn("c1", "s1");
        routes.learn("c1", "s2");
        assert_eq!(routes.of("c1").as_deref(), Some("s2"));
        routes.forget("c1");
        assert_eq!(routes.of("c1"), None);
        assert!(routes.watch("w1", "s1"));
        assert!(!routes.watch("w2", "s1"));
        assert!(routes.watching("s1"));
        assert_eq!(routes.unwatch("w1"), None);
        assert_eq!(routes.unwatch("w2").as_deref(), Some("s1"));
        assert!(!routes.watching("s1"));
        assert_eq!(routes.unwatch("unknown"), None);
        for n in 0..NAMES + 1 {
            routes.learn(&format!("c{n}"), "s");
        }
        assert_eq!(routes.of("c0"), None, "the oldest name is forgotten");
    }
}
