//! The sessions open on the databases of the modules, and what the application must know of
//! each to apply its rules without the client sending the connection again.
use nexo_domain::{DocumentId, Error, Result, WorkspaceId, sql::ConnectionType};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::Duration,
};

/// Sessions open at once, as many as the drivers keep connections.
const SESSIONS: usize = 16;

pub(crate) struct Session {
    pub workspace: WorkspaceId,
    pub connection: DocumentId,
    /// The name of the saved connection, for the history.
    pub name: String,
    pub driver: String,
    pub read_only: bool,
    pub kind: ConnectionType,
    pub timeout: Option<Duration>,
    /// The vault values the connection used, to keep them out of every answer.
    pub secrets: Vec<(String, String)>,
}

#[derive(Default)]
pub(crate) struct Sessions(Mutex<HashMap<String, Arc<Session>>>);

/// A session name: letters, digits and `_ . : -`, as the client chooses it (one per editor).
pub(crate) fn session_name(name: &str) -> Result<&str> {
    let valid = (1..=128).contains(&name.len())
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | ':' | '-'));
    if valid {
        Ok(name)
    } else {
        Err(Error::Validation("Invalid session name".into()))
    }
}

impl Sessions {
    pub fn get(&self, name: &str) -> Result<Arc<Session>> {
        self.0
            .lock()
            .unwrap()
            .get(name)
            .cloned()
            .ok_or_else(|| Error::Validation("The session is not open: connect first".into()))
    }
    /// Registers a session; refuses when too many are open.
    pub fn insert(&self, name: &str, session: Session) -> Result<()> {
        let mut sessions = self.0.lock().unwrap();
        if !sessions.contains_key(name) && sessions.len() >= SESSIONS {
            return Err(Error::Validation(format!(
                "There are already {SESSIONS} database sessions open; close one first"
            )));
        }
        sessions.insert(name.to_owned(), Arc::new(session));
        Ok(())
    }
    pub fn remove(&self, name: &str) -> Option<Arc<Session>> {
        self.0.lock().unwrap().remove(name)
    }
}
