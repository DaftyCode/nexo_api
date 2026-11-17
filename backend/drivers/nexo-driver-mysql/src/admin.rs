//! The sessions and locks of a MySQL or MariaDB server: `information_schema.PROCESSLIST`,
//! InnoDB's lock waits (`sys.innodb_lock_waits` in MySQL, `INNODB_LOCK_WAITS` in MariaDB),
//! and `KILL QUERY` and `KILL CONNECTION`. Without `PROCESS` a user sees only its own
//! sessions, and the view says so.
use crate::connection::Server;
use nexo_driver_sdk::{
    Result,
    admin::{AdminCatalog, AdminQuery, KillMode, numeric_id},
};

pub struct MysqlAdmin {
    pub server: Server,
}

impl AdminCatalog for MysqlAdmin {
    fn sessions(&self) -> String {
        "SELECT p.ID, p.USER, p.DB, NULL, p.HOST, \
         CONCAT_WS(': ', p.COMMAND, NULLIF(p.STATE, '')), p.TIME, \
         CASE WHEN p.STATE LIKE 'Waiting%' OR p.STATE LIKE '%lock%' THEN p.STATE END, p.INFO, \
         p.ID = CONNECTION_ID(), p.COMMAND NOT IN ('Sleep', 'Daemon', 'Binlog Dump') \
         FROM information_schema.PROCESSLIST p ORDER BY p.ID"
            .into()
    }
    fn locks(&self) -> String {
        if self.server.mariadb {
            "SELECT r.trx_mysql_thread_id, b.trx_mysql_thread_id, l.lock_table, l.lock_mode, \
             TIMESTAMPDIFF(SECOND, r.trx_wait_started, NOW()), rp.USER, r.trx_query, bp.USER, \
             COALESCE(b.trx_query, bp.INFO) FROM information_schema.INNODB_LOCK_WAITS w \
             JOIN information_schema.INNODB_TRX r ON r.trx_id = w.requesting_trx_id \
             JOIN information_schema.INNODB_TRX b ON b.trx_id = w.blocking_trx_id \
             LEFT JOIN information_schema.INNODB_LOCKS l ON l.lock_id = w.requested_lock_id \
             LEFT JOIN information_schema.PROCESSLIST rp ON rp.ID = r.trx_mysql_thread_id \
             LEFT JOIN information_schema.PROCESSLIST bp ON bp.ID = b.trx_mysql_thread_id"
                .into()
        } else {
            "SELECT w.waiting_pid, w.blocking_pid, w.locked_table, w.waiting_lock_mode, \
             w.wait_age_secs, wp.USER, w.waiting_query, bp.USER, COALESCE(w.blocking_query, bp.INFO) \
             FROM sys.innodb_lock_waits w \
             LEFT JOIN information_schema.PROCESSLIST wp ON wp.ID = w.waiting_pid \
             LEFT JOIN information_schema.PROCESSLIST bp ON bp.ID = w.blocking_pid"
                .into()
        }
    }
    fn privilege(&self) -> String {
        "SELECT CASE WHEN EXISTS (SELECT 1 FROM information_schema.USER_PRIVILEGES \
         WHERE PRIVILEGE_TYPE = 'PROCESS' AND GRANTEE = CONCAT('''', \
         SUBSTRING_INDEX(CURRENT_USER(), '@', 1), '''@''', SUBSTRING_INDEX(CURRENT_USER(), '@', -1), '''')) \
         THEN NULL ELSE 'PROCESS' END"
            .into()
    }
    fn own(&self) -> String {
        "SELECT CONNECTION_ID()".into()
    }
    /// `KILL` takes no bound value: the id goes in as the number it was checked to be.
    fn kill(&self, id: &str, mode: KillMode) -> Result<AdminQuery> {
        let id = numeric_id(id)?;
        let what = match mode {
            KillMode::Cancel => "QUERY",
            KillMode::Terminate => "CONNECTION",
        };
        Ok(AdminQuery {
            sql: format!("KILL {what} {id}"),
            params: Vec::new(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn admin(mariadb: bool) -> MysqlAdmin {
        MysqlAdmin {
            server: Server {
                major: 11,
                minor: 4,
                mariadb,
            },
        }
    }

    #[test]
    fn kill_gets_the_number_and_each_server_its_own_lock_catalog() {
        assert_eq!(
            admin(false).kill("12", KillMode::Cancel).unwrap().sql,
            "KILL QUERY 12"
        );
        assert_eq!(
            admin(false).kill("12", KillMode::Terminate).unwrap().sql,
            "KILL CONNECTION 12"
        );
        assert!(
            admin(false)
                .kill("12; DROP TABLE t", KillMode::Cancel)
                .is_err()
        );
        assert!(admin(true).locks().contains("INNODB_LOCK_WAITS"));
        assert!(admin(false).locks().contains("sys.innodb_lock_waits"));
    }
}
