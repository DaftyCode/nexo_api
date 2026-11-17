//! Payloads of the administration of a database server (`db.sessions`, `db.locks`,
//! `db.session.kill`).
use super::*;

payload! {
    /// `db.sessions` and `db.locks`: the sessions of the server of a session's connection,
    /// and who waits for whom, read on that session.
    closed DbAdminPayload {
        required {
            session "session": String => "string",
            statement "statement": String => "string",
        }
        optional {
            workspace "workspace": String => "string",
        }
    }
}

payload! {
    /// `db.dashboard.read`: a reading of a panel of the server's dashboard: one query that
    /// only reads, not recorded in the history.
    closed DbDashboardReadPayload {
        required {
            session "session": String => "string",
            statement "statement": String => "string",
            sql "sql": String => "string",
        }
        optional {
            workspace "workspace": String => "string",
        }
    }
}

payload! {
    /// `db.session.kill`: cancels the statement of the server's session `target`, or ends it.
    /// Refused on a read-only connection; `confirm` always, and on production also
    /// `confirmName` with the id of the session.
    closed DbSessionKillPayload {
        required {
            session "session": String => "string",
            statement "statement": String => "string",
            target "target": String => "string",
            mode "mode": String => "'cancel' | 'terminate'",
        }
        optional {
            confirm "confirm": bool => "boolean",
            confirm_name "confirmName": String => "string",
            workspace "workspace": String => "string",
        }
    }
}
