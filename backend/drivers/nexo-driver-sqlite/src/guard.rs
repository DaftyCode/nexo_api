//! What keeps a session inside its file and within its time: an authorizer that refuses
//! `ATTACH`, `DETACH`, extensions and the pragmas that name folders (and, in a read-only
//! session, turning `query_only` off), and a progress handler that stops a statement at its
//! deadline. Both are SQLite's own hooks: SQL cannot remove them.
use rusqlite::{
    Connection,
    config::DbConfig,
    hooks::{AuthAction, AuthContext, Authorization},
};
use std::{
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
    time::{Duration, Instant},
};

/// Why the authorizer refused what a statement does, in words for the person.
fn refusal(action: AuthAction<'_>, read_only: bool) -> Option<&'static str> {
    match action {
        AuthAction::Attach { .. } => Some(
            "ATTACH DATABASE is not allowed: a SQLite connection of Nexo opens only its own file",
        ),
        AuthAction::Detach { .. } => Some(
            "DETACH DATABASE is not allowed: a SQLite connection of Nexo opens only its own file",
        ),
        AuthAction::Function { function_name }
            if function_name.eq_ignore_ascii_case("load_extension") =>
        {
            Some("load_extension is not allowed: Nexo does not load SQLite extensions")
        }
        AuthAction::Pragma { pragma_name, .. }
            if pragma_name.eq_ignore_ascii_case("temp_store_directory")
                || pragma_name.eq_ignore_ascii_case("data_store_directory") =>
        {
            Some("This pragma is not allowed: it names a folder of the disk")
        }
        AuthAction::Pragma {
            pragma_name,
            pragma_value: Some(_),
        } if read_only
            && (pragma_name.eq_ignore_ascii_case("query_only")
                || pragma_name.eq_ignore_ascii_case("writable_schema")) =>
        {
            Some("The connection is read-only: its pragmas cannot make it write")
        }
        _ => None,
    }
}

/// The hooks of a session, and what they found.
#[derive(Clone)]
pub(crate) struct Guard {
    /// Why the authorizer refused the last statement it refused.
    refused: Arc<Mutex<Option<&'static str>>>,
    /// When the running statement must stop, in milliseconds from `started`; 0 for never.
    deadline: Arc<AtomicU64>,
    timed_out: Arc<AtomicBool>,
    started: Instant,
}

impl Guard {
    /// Installs the hooks on a connection just opened, and SQLite's own defences.
    pub fn install(conn: &mut Connection, read_only: bool) -> rusqlite::Result<Self> {
        let guard = Self {
            refused: Arc::default(),
            deadline: Arc::default(),
            timed_out: Arc::default(),
            started: Instant::now(),
        };
        // The schema of a file nobody checked cannot call functions with side effects, nor
        // be written by hand into a corrupt one.
        conn.set_db_config(DbConfig::SQLITE_DBCONFIG_TRUSTED_SCHEMA, false)?;
        conn.set_db_config(DbConfig::SQLITE_DBCONFIG_DEFENSIVE, true)?;
        let refused = guard.refused.clone();
        conn.authorizer(Some(move |context: AuthContext<'_>| {
            match refusal(context.action, read_only) {
                Some(reason) => {
                    *refused.lock().unwrap() = Some(reason);
                    Authorization::Deny
                }
                None => Authorization::Allow,
            }
        }))?;
        let (deadline, timed_out, started) = (
            guard.deadline.clone(),
            guard.timed_out.clone(),
            guard.started,
        );
        conn.progress_handler(
            1_000,
            Some(move || {
                let limit = deadline.load(Ordering::Relaxed);
                let late = limit != 0 && started.elapsed().as_millis() as u64 >= limit;
                if late {
                    timed_out.store(true, Ordering::Relaxed);
                }
                late
            }),
        )?;
        Ok(guard)
    }

    /// Starts the clock of a statement (or of one of its pages).
    pub fn arm(&self, limit: Duration) {
        let at = self.started.elapsed() + limit;
        self.deadline
            .store(at.as_millis().max(1) as u64, Ordering::Relaxed);
        self.timed_out.store(false, Ordering::Relaxed);
        *self.refused.lock().unwrap() = None;
    }
    pub fn disarm(&self) {
        self.deadline.store(0, Ordering::Relaxed);
    }
    /// The statement ran past its deadline.
    pub fn timed_out(&self) -> bool {
        self.timed_out.load(Ordering::Relaxed)
    }
    /// Why the authorizer refused the statement, if it did.
    pub fn refused(&self) -> Option<&'static str> {
        *self.refused.lock().unwrap()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn refuses_what_leaves_the_file() {
        let attach = AuthAction::Attach { filename: "x.db" };
        assert!(refusal(attach, false).is_some());
        let function = AuthAction::Function {
            function_name: "LOAD_EXTENSION",
        };
        assert!(refusal(function, false).is_some());
        let length = AuthAction::Function {
            function_name: "length",
        };
        assert!(refusal(length, false).is_none());
        let off = AuthAction::Pragma {
            pragma_name: "query_only",
            pragma_value: Some("0"),
        };
        assert!(refusal(off, true).is_some());
        assert!(refusal(off, false).is_none());
        let read = AuthAction::Pragma {
            pragma_name: "query_only",
            pragma_value: None,
        };
        assert!(refusal(read, true).is_none());
        let folder = AuthAction::Pragma {
            pragma_name: "temp_store_directory",
            pragma_value: Some("'/tmp'"),
        };
        assert!(refusal(folder, false).is_some());
    }
}
