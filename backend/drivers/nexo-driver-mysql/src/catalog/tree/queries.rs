//! The queries that list the folders of a database and the parts of a table.
use super::{CODE, OPEN, RELATION, SEEN};

/// The query that lists a folder of database `?`, its kind, actions and whether its nodes
/// open.
pub(super) fn folder_sql(
    folder: &str,
) -> Option<(&'static str, &'static str, &'static [&'static str], bool)> {
    Some(match folder {
        "tables" => (
            "SELECT TABLE_NAME, CONCAT('~', TABLE_ROWS, ' rows') FROM information_schema.TABLES \
             WHERE TABLE_SCHEMA = ? AND TABLE_TYPE IN ('BASE TABLE', 'SYSTEM VERSIONED') ORDER BY 1",
            "table",
            RELATION,
            true,
        ),
        "views" => (
            "SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? \
             AND TABLE_TYPE IN ('VIEW', 'SYSTEM VIEW') ORDER BY 1",
            "view",
            RELATION,
            true,
        ),
        "procedures" => (
            "SELECT ROUTINE_NAME FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA = ? \
             AND ROUTINE_TYPE = 'PROCEDURE' ORDER BY 1",
            "procedure",
            CODE,
            false,
        ),
        "functions" => (
            "SELECT ROUTINE_NAME, DTD_IDENTIFIER FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA = ? \
             AND ROUTINE_TYPE = 'FUNCTION' ORDER BY 1",
            "function",
            CODE,
            false,
        ),
        "triggers" => (
            "SELECT TRIGGER_NAME, CONCAT(LOWER(ACTION_TIMING), ' ', LOWER(EVENT_MANIPULATION), ' ', EVENT_OBJECT_TABLE) \
             FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = ? ORDER BY 1",
            "trigger",
            CODE,
            false,
        ),
        "events" => (
            "SELECT EVENT_NAME, LOWER(STATUS) FROM information_schema.EVENTS WHERE EVENT_SCHEMA = ? ORDER BY 1",
            "event",
            CODE,
            false,
        ),
        "sequences" => (
            "SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? \
             AND TABLE_TYPE = 'SEQUENCE' ORDER BY 1",
            "sequence",
            CODE,
            false,
        ),
        _ => return None,
    })
}

/// The query that lists a part of table `?`.`?`, the kind of its nodes and their actions.
pub(super) fn part_sql(
    part: &str,
) -> Option<(String, &'static str, &'static [&'static str], bool)> {
    let where_table = "TABLE_SCHEMA = ? AND TABLE_NAME = ?";
    Some(match part {
        "columns" => (
            format!(
                "SELECT COLUMN_NAME, CONCAT(COLUMN_TYPE, IF(IS_NULLABLE = 'NO', ' not null', '')) \
                 FROM information_schema.COLUMNS WHERE {where_table} ORDER BY ORDINAL_POSITION"
            ),
            "column",
            OPEN,
            false,
        ),
        "constraints" => (
            format!(
                "SELECT CONSTRAINT_NAME, LOWER(CONSTRAINT_TYPE) FROM information_schema.TABLE_CONSTRAINTS \
                 WHERE {where_table} AND CONSTRAINT_TYPE IN ('PRIMARY KEY', 'UNIQUE', 'CHECK') ORDER BY 1"
            ),
            "constraint",
            SEEN,
            false,
        ),
        "foreign-keys" => (
            "SELECT CONSTRAINT_NAME, CONCAT('references ', REFERENCED_TABLE_NAME) \
             FROM information_schema.REFERENTIAL_CONSTRAINTS WHERE CONSTRAINT_SCHEMA = ? AND TABLE_NAME = ? ORDER BY 1"
                .into(),
            "constraint",
            SEEN,
            false,
        ),
        "indexes" => (
            format!(
                "SELECT INDEX_NAME, MIN(IF(NON_UNIQUE = 0, 'unique', LOWER(INDEX_TYPE))) \
                 FROM information_schema.STATISTICS WHERE {where_table} GROUP BY INDEX_NAME \
                 ORDER BY INDEX_NAME = 'PRIMARY' DESC, INDEX_NAME"
            ),
            "index",
            SEEN,
            false,
        ),
        "references" => (
            "SELECT CONCAT(CONSTRAINT_SCHEMA, '.', TABLE_NAME, '.', CONSTRAINT_NAME), \
             CONCAT(CONSTRAINT_SCHEMA, '.', TABLE_NAME), CONSTRAINT_NAME FROM information_schema.REFERENTIAL_CONSTRAINTS \
             WHERE UNIQUE_CONSTRAINT_SCHEMA = ? AND REFERENCED_TABLE_NAME = ? ORDER BY 2, 3"
                .into(),
            "reference",
            SEEN,
            true,
        ),
        "triggers" => (
            "SELECT TRIGGER_NAME, CONCAT(LOWER(ACTION_TIMING), ' ', LOWER(EVENT_MANIPULATION)) \
             FROM information_schema.TRIGGERS WHERE EVENT_OBJECT_SCHEMA = ? AND EVENT_OBJECT_TABLE = ? ORDER BY 1"
                .into(),
            "trigger",
            SEEN,
            false,
        ),
        "partitions" => (
            format!(
                "SELECT PARTITION_NAME, PARTITION_DESCRIPTION FROM information_schema.PARTITIONS \
                 WHERE {where_table} AND PARTITION_NAME IS NOT NULL ORDER BY PARTITION_ORDINAL_POSITION"
            ),
            "partition",
            SEEN,
            false,
        ),
        _ => return None,
    })
}
