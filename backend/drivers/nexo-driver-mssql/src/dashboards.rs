//! The panels of a SQL Server's dashboard, from `sys.dm_exec_sessions` and
//! `sys.dm_exec_requests` and the counters of `sys.dm_os_performance_counters` (which need
//! `VIEW SERVER STATE`): its sessions, its transactions and batches and pages per second,
//! the size of the database and the requests waiting for a lock.
use nexo_driver_sdk::dashboard::{ChartKind, Dashboard};

/// The counters named, as one row. The `/sec` counters only grow, so they are drawn as
/// changes per second.
fn counters(columns: &[(&str, &str)]) -> String {
    let columns: Vec<String> = columns
        .iter()
        .map(|(counter, name)| {
            format!(
                "CAST(SUM(CASE WHEN RTRIM(counter_name) = '{counter}' THEN cntr_value END) \
                 AS float) AS [{name}]"
            )
        })
        .collect();
    format!(
        "SELECT {} FROM sys.dm_os_performance_counters WHERE RTRIM(instance_name) IN ('', '_Total')",
        columns.join(", ")
    )
}

pub fn predefined() -> Vec<Dashboard> {
    vec![
        Dashboard::new(
            "sessions",
            "Sessions",
            ChartKind::Line,
            "SELECT COUNT(r.session_id) AS active, COUNT(*) - COUNT(r.session_id) AS idle \
             FROM sys.dm_exec_sessions s \
             LEFT JOIN sys.dm_exec_requests r ON r.session_id = s.session_id \
             WHERE s.is_user_process = 1",
        )
        .unit("sessions"),
        Dashboard::new(
            "transactions",
            "Transactions",
            ChartKind::Area,
            counters(&[
                ("Transactions/sec", "transactions"),
                ("Batch Requests/sec", "batches"),
            ]),
        )
        .unit("transactions")
        .per_second(),
        Dashboard::new(
            "pages",
            "Pages read and written",
            ChartKind::Line,
            counters(&[("Page reads/sec", "read"), ("Page writes/sec", "written")]),
        )
        .unit("pages")
        .per_second(),
        Dashboard::new(
            "size",
            "Size of the database",
            ChartKind::Value,
            "SELECT CAST(SUM(CAST(size AS bigint)) * 8192 AS float) AS size FROM sys.database_files",
        )
        .unit("bytes"),
        Dashboard::new(
            "locks",
            "Locks waited for",
            ChartKind::Line,
            "SELECT COUNT(*) AS waiting FROM sys.dm_exec_requests WHERE blocking_session_id <> 0",
        )
        .unit("requests"),
    ]
}

#[cfg(test)]
mod tests {
    #[test]
    fn each_counter_is_a_column() {
        let sql = super::counters(&[("Page reads/sec", "read")]);
        assert!(sql.contains("RTRIM(counter_name) = 'Page reads/sec'"));
        assert!(sql.contains("AS [read]"));
    }
}
