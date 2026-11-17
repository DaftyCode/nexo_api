//! The sessions and locks of a PostgreSQL server: `pg_stat_activity`, `pg_locks` with
//! `pg_blocking_pids`, and `pg_cancel_backend` and `pg_terminate_backend`. Without
//! `pg_read_all_stats` (a part of `pg_monitor`) the statements of other users' sessions are
//! hidden, and the view says so.
use nexo_driver_sdk::{
    Result, Value,
    admin::{AdminCatalog, AdminQuery, KillMode, numeric_id},
};

pub struct PgAdmin;

impl AdminCatalog for PgAdmin {
    fn sessions(&self) -> String {
        "SELECT a.pid::text, a.usename::text, a.datname::text, NULLIF(a.application_name, ''), \
         CASE WHEN a.client_addr IS NOT NULL THEN host(a.client_addr) || ':' || a.client_port \
         WHEN a.client_port = -1 THEN 'local' END, a.state, \
         EXTRACT(EPOCH FROM now() - COALESCE(a.state_change, a.backend_start))::float8, \
         CASE WHEN a.wait_event IS NOT NULL THEN a.wait_event_type || ': ' || a.wait_event END, \
         a.query, a.pid = pg_backend_pid(), COALESCE(a.state <> 'idle', false) \
         FROM pg_stat_activity a WHERE a.backend_type = 'client backend' ORDER BY a.pid"
            .into()
    }
    fn locks(&self) -> String {
        "SELECT w.pid::text, b.pid::text, \
         (SELECT string_agg(DISTINCT COALESCE(l.relation::regclass::text, l.locktype), ', ') \
         FROM pg_locks l WHERE l.pid = w.pid AND NOT l.granted), \
         (SELECT string_agg(DISTINCT l.mode, ', ') FROM pg_locks l WHERE l.pid = w.pid AND NOT l.granted), \
         EXTRACT(EPOCH FROM now() - COALESCE(w.query_start, w.state_change))::float8, \
         w.usename::text, w.query, b.usename::text, b.query \
         FROM pg_stat_activity w CROSS JOIN LATERAL unnest(pg_blocking_pids(w.pid)) AS blocker(pid) \
         JOIN pg_stat_activity b ON b.pid = blocker.pid ORDER BY b.pid, w.pid"
            .into()
    }
    fn privilege(&self) -> String {
        "SELECT CASE WHEN (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) \
         OR pg_has_role(current_user, 'pg_read_all_stats', 'MEMBER') THEN NULL ELSE 'pg_monitor' END"
            .into()
    }
    fn own(&self) -> String {
        "SELECT pg_backend_pid()::text".into()
    }
    fn kill(&self, id: &str, mode: KillMode) -> Result<AdminQuery> {
        let function = match mode {
            KillMode::Cancel => "pg_cancel_backend",
            KillMode::Terminate => "pg_terminate_backend",
        };
        Ok(AdminQuery {
            sql: format!("SELECT {function}($1)"),
            params: vec![Value::Integer(numeric_id(id)?)],
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_session_is_cancelled_or_ended_by_its_bound_number() {
        let cancel = PgAdmin.kill("42", KillMode::Cancel).unwrap();
        assert_eq!(cancel.sql, "SELECT pg_cancel_backend($1)");
        assert_eq!(cancel.params, vec![Value::Integer(42)]);
        let end = PgAdmin.kill(" 7 ", KillMode::Terminate).unwrap();
        assert_eq!(end.sql, "SELECT pg_terminate_backend($1)");
        assert!(PgAdmin.kill("7 OR 1=1", KillMode::Cancel).is_err());
    }
}
