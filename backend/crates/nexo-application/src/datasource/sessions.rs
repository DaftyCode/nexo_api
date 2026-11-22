//! The sessions open on the databases of the modules, and what the application must know of
//! each to apply its rules without the client sending the connection again.
use super::journal::Journal;
use crate::ports::SqlConnection;
use nexo_domain::{DocumentId, Error, Result, WorkspaceId, sql::TypeRules};
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
    /// What the connection's type asks of it: confirmations, only reading, a time limit.
    pub rules: TypeRules,
    pub timeout: Option<Duration>,
    /// The vault values the connection used, to keep them out of every answer.
    pub secrets: Vec<(String, String)>,
    /// Its transaction: the statements since it began.
    pub journal: Mutex<Journal>,
    /// What it opened with, its secrets included, to open it again when it closed (DB-25).
    pub opened: SqlConnection,
    /// What it runs as it opens: its default schema and its startup queries.
    pub opening: Vec<String>,
    pub ignore_startup_errors: bool,
}

/// The open sessions, and the passwords typed for connections that keep none (DB-25), kept
/// while a session of theirs is open.
#[derive(Default)]
pub(crate) struct Sessions {
    open: Mutex<HashMap<String, Arc<Session>>>,
    asked: Mutex<HashMap<(WorkspaceId, DocumentId), String>>,
    /// The subscriptions of key-value stores open in the realtime panel: id and what they
    /// follow (DB-35).
    followed: Mutex<std::collections::BTreeMap<String, String>>,
}

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
    pub fn follow(&self, id: &str, what: String) {
        self.followed.lock().unwrap().insert(id.to_owned(), what);
    }
    pub fn unfollow(&self, id: &str) {
        self.followed.lock().unwrap().remove(id);
    }
    pub fn followed(&self) -> Vec<(String, String)> {
        let followed = self.followed.lock().unwrap();
        followed
            .iter()
            .map(|(id, what)| (id.clone(), what.clone()))
            .collect()
    }
    pub fn get(&self, name: &str) -> Result<Arc<Session>> {
        self.open
            .lock()
            .unwrap()
            .get(name)
            .cloned()
            .ok_or_else(|| Error::Validation("The session is not open: connect first".into()))
    }
    /// Registers a session; refuses when too many are open.
    pub fn insert(&self, name: &str, session: Session) -> Result<()> {
        let mut sessions = self.open.lock().unwrap();
        if !sessions.contains_key(name) && sessions.len() >= SESSIONS {
            return Err(Error::Validation(format!(
                "There are already {SESSIONS} database sessions open; close one first"
            )));
        }
        sessions.insert(name.to_owned(), Arc::new(session));
        Ok(())
    }
    /// Takes out a session; the password typed for its connection goes with its last one.
    pub fn remove(&self, name: &str) -> Option<Arc<Session>> {
        let mut sessions = self.open.lock().unwrap();
        let removed = sessions.remove(name)?;
        let key = (removed.workspace.clone(), removed.connection.clone());
        if !sessions
            .values()
            .any(|other| other.workspace == key.0 && other.connection == key.1)
        {
            self.asked.lock().unwrap().remove(&key);
        }
        Some(removed)
    }
    /// The password typed for a connection while a session of it is open.
    pub fn asked(&self, workspace: &WorkspaceId, connection: &DocumentId) -> Option<String> {
        let key = (workspace.clone(), connection.clone());
        self.asked.lock().unwrap().get(&key).cloned()
    }
    pub fn remember(&self, workspace: &WorkspaceId, connection: &DocumentId, password: String) {
        let key = (workspace.clone(), connection.clone());
        self.asked.lock().unwrap().insert(key, password);
    }
    /// Every open session, by name.
    pub fn all(&self) -> Vec<(String, Arc<Session>)> {
        let sessions = self.open.lock().unwrap();
        let mut all: Vec<_> = sessions
            .iter()
            .map(|(name, session)| (name.clone(), session.clone()))
            .collect();
        all.sort_by(|a, b| a.0.cmp(&b.0));
        all
    }
}
