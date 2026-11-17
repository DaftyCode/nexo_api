//! The panels of a PostgreSQL server's dashboard, from `pg_stat_activity`,
//! `pg_stat_database` and `pg_locks`: its sessions, its transactions and rows per second,
//! the size of the database and the locks waited for.
use nexo_driver_sdk::dashboard::{ChartKind, Dashboard};

pub fn predefined() -> Vec<Dashboard> {
    vec![
        Dashboard::new(
            "sessions",
            "Sessions",
            ChartKind::Line,
            "SELECT count(*) FILTER (WHERE state = 'active') AS active, \
             count(*) FILTER (WHERE state = 'idle') AS idle, \
             count(*) FILTER (WHERE state LIKE 'idle in transaction%') AS \"idle in transaction\" \
             FROM pg_stat_activity WHERE backend_type = 'client backend'",
        )
        .unit("sessions"),
        Dashboard::new(
            "transactions",
            "Transactions",
            ChartKind::Area,
            "SELECT sum(xact_commit)::float8 AS commits, sum(xact_rollback)::float8 AS rollbacks \
             FROM pg_stat_database",
        )
        .unit("transactions")
        .per_second(),
        Dashboard::new(
            "rows",
            "Rows read and written",
            ChartKind::Line,
            "SELECT sum(tup_returned + tup_fetched)::float8 AS read, \
             sum(tup_inserted + tup_updated + tup_deleted)::float8 AS written FROM pg_stat_database",
        )
        .unit("rows")
        .per_second(),
        Dashboard::new(
            "blocks",
            "Blocks from disk and cache",
            ChartKind::Line,
            "SELECT sum(blks_read)::float8 AS disk, sum(blks_hit)::float8 AS cache \
             FROM pg_stat_database",
        )
        .unit("blocks")
        .per_second(),
        Dashboard::new(
            "size",
            "Size of the database",
            ChartKind::Value,
            "SELECT pg_database_size(current_database())::float8 AS size",
        )
        .unit("bytes"),
        Dashboard::new(
            "locks",
            "Locks waited for",
            ChartKind::Line,
            "SELECT count(*) AS waiting FROM pg_locks WHERE NOT granted",
        )
        .unit("locks"),
        Dashboard::new(
            "databases",
            "Sessions by database",
            ChartKind::Bar,
            "SELECT datname::text, count(*) FROM pg_stat_activity \
             WHERE datname IS NOT NULL GROUP BY datname ORDER BY 2 DESC LIMIT 10",
        )
        .unit("sessions"),
    ]
}
