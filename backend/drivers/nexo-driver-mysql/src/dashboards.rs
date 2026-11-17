//! The panels of a MySQL or MariaDB server's dashboard, from `SHOW GLOBAL STATUS` (a row per
//! counter, a series each) and `information_schema`: its threads, its transactions and
//! queries, InnoDB's rows per second, the size of the database and the row locks waited for.
use nexo_driver_sdk::dashboard::{ChartKind, Dashboard};

/// The status counters named, a row each.
fn status(names: &[&str]) -> String {
    let names: Vec<String> = names.iter().map(|name| format!("'{name}'")).collect();
    format!(
        "SHOW GLOBAL STATUS WHERE Variable_name IN ({})",
        names.join(", ")
    )
}

pub fn predefined() -> Vec<Dashboard> {
    vec![
        Dashboard::new(
            "sessions",
            "Sessions",
            ChartKind::Line,
            status(&["Threads_connected", "Threads_running"]),
        )
        .unit("sessions"),
        Dashboard::new(
            "transactions",
            "Transactions",
            ChartKind::Area,
            status(&["Com_commit", "Com_rollback"]),
        )
        .unit("transactions")
        .per_second(),
        Dashboard::new(
            "queries",
            "Queries",
            ChartKind::Line,
            status(&["Questions", "Slow_queries"]),
        )
        .unit("queries")
        .per_second(),
        Dashboard::new(
            "rows",
            "Rows read and written",
            ChartKind::Line,
            status(&[
                "Innodb_rows_read",
                "Innodb_rows_inserted",
                "Innodb_rows_updated",
                "Innodb_rows_deleted",
            ]),
        )
        .unit("rows")
        .per_second(),
        Dashboard::new(
            "size",
            "Size of the database",
            ChartKind::Value,
            "SELECT COALESCE(SUM(data_length + index_length), 0) AS size \
             FROM information_schema.TABLES WHERE table_schema = DATABASE()",
        )
        .unit("bytes"),
        Dashboard::new(
            "locks",
            "Locks waited for",
            ChartKind::Line,
            status(&["Innodb_row_lock_current_waits"]),
        )
        .unit("locks"),
    ]
}

#[cfg(test)]
mod tests {
    #[test]
    fn counters_are_named_in_one_show() {
        assert_eq!(
            super::status(&["A", "B"]),
            "SHOW GLOBAL STATUS WHERE Variable_name IN ('A', 'B')"
        );
        assert_eq!(super::predefined().len(), 6);
    }
}
