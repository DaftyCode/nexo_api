//! The sessions and locks of a SQL Server: `sys.dm_exec_sessions` and `sys.dm_exec_requests`,
//! the waits of `blocking_session_id` with what `sys.dm_tran_locks` waits for, and `KILL`.
//! SQL Server cancels the statement of another session only by ending it, so `kill` has the
//! one mode. Without `VIEW SERVER STATE` a user sees only its own session, and the view
//! says so.
use nexo_driver_sdk::{
    DriverError, Result,
    admin::{AdminCatalog, AdminQuery, KillMode, numeric_id},
};

pub struct SqlServerAdmin;

/// What a waiting request waits for: its table where SQL Server can say, else its resource.
const WAITED: &str = "COALESCE(\
    (SELECT TOP 1 OBJECT_SCHEMA_NAME(p.object_id) + '.' + OBJECT_NAME(p.object_id) \
     FROM sys.dm_tran_locks l JOIN sys.partitions p ON p.hobt_id = l.resource_associated_entity_id \
     WHERE l.request_session_id = r.session_id AND l.request_status = 'WAIT' \
     AND l.resource_database_id = DB_ID()), \
    (SELECT TOP 1 OBJECT_SCHEMA_NAME(l.resource_associated_entity_id, l.resource_database_id) + '.' \
     + OBJECT_NAME(l.resource_associated_entity_id, l.resource_database_id) FROM sys.dm_tran_locks l \
     WHERE l.request_session_id = r.session_id AND l.request_status = 'WAIT' \
     AND l.resource_type = 'OBJECT'), \
    r.wait_resource)";

impl AdminCatalog for SqlServerAdmin {
    fn sessions(&self) -> String {
        "SELECT s.session_id, s.login_name, DB_NAME(s.database_id), NULLIF(s.program_name, ''), \
         COALESCE(c.client_net_address + ':' + CAST(c.client_tcp_port AS varchar(10)), \
         NULLIF(s.host_name, '')), COALESCE(r.status, s.status), \
         DATEDIFF(SECOND, COALESCE(r.start_time, s.last_request_end_time, s.login_time), SYSDATETIME()), \
         r.wait_type, t.text, CASE WHEN s.session_id = @@SPID THEN 1 ELSE 0 END, \
         CASE WHEN r.session_id IS NULL THEN 0 ELSE 1 END \
         FROM sys.dm_exec_sessions s \
         LEFT JOIN sys.dm_exec_requests r ON r.session_id = s.session_id \
         LEFT JOIN sys.dm_exec_connections c ON c.session_id = s.session_id \
         AND c.parent_connection_id IS NULL \
         OUTER APPLY sys.dm_exec_sql_text(COALESCE(r.sql_handle, c.most_recent_sql_handle)) t \
         WHERE s.is_user_process = 1 ORDER BY s.session_id"
            .into()
    }
    fn locks(&self) -> String {
        format!(
            "SELECT r.session_id, r.blocking_session_id, {WAITED}, \
             (SELECT TOP 1 l.request_mode FROM sys.dm_tran_locks l \
             WHERE l.request_session_id = r.session_id AND l.request_status = 'WAIT'), \
             r.wait_time / 1000.0, ws.login_name, wt.text, bs.login_name, bt.text \
             FROM sys.dm_exec_requests r \
             JOIN sys.dm_exec_sessions ws ON ws.session_id = r.session_id \
             LEFT JOIN sys.dm_exec_sessions bs ON bs.session_id = r.blocking_session_id \
             LEFT JOIN sys.dm_exec_connections bc ON bc.session_id = r.blocking_session_id \
             AND bc.parent_connection_id IS NULL \
             OUTER APPLY sys.dm_exec_sql_text(r.sql_handle) wt \
             OUTER APPLY sys.dm_exec_sql_text(bc.most_recent_sql_handle) bt \
             WHERE r.blocking_session_id <> 0 ORDER BY r.blocking_session_id, r.session_id"
        )
    }
    fn privilege(&self) -> String {
        "SELECT CASE WHEN HAS_PERMS_BY_NAME(NULL, NULL, 'VIEW SERVER STATE') = 1 \
         THEN NULL ELSE 'VIEW SERVER STATE' END"
            .into()
    }
    fn own(&self) -> String {
        "SELECT @@SPID".into()
    }
    /// `KILL` takes no variable: the id goes in as the number it was checked to be.
    fn kill(&self, id: &str, mode: KillMode) -> Result<AdminQuery> {
        let id = numeric_id(id)?;
        match mode {
            KillMode::Terminate => Ok(AdminQuery {
                sql: format!("KILL {id}"),
                params: Vec::new(),
            }),
            KillMode::Cancel => Err(DriverError::unsupported(
                "SQL Server cancels the statement of another session only by ending the session",
            )),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_session_is_only_ended_by_its_number() {
        assert_eq!(
            SqlServerAdmin.kill("57", KillMode::Terminate).unwrap().sql,
            "KILL 57"
        );
        assert!(SqlServerAdmin.kill("57", KillMode::Cancel).is_err());
        assert!(SqlServerAdmin.kill("57 --", KillMode::Terminate).is_err());
    }
}
