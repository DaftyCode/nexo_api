//! A table or a view: its properties, columns, keys, indexes, triggers and partitions.
use super::described;
use crate::{
    catalog::{key_columns, properties, query, section, unknown},
    connection::MyConnection,
};
use nexo_driver_sdk::{Result, protocol::ObjectDescription};

/// The checks of a table, where the server has them (MySQL 8.0.16, MariaDB 10.2).
fn checks(connection: &MyConnection) -> &'static str {
    let server = connection.server;
    if server.mariadb && server.at_least(10, 2) {
        "LEFT JOIN information_schema.CHECK_CONSTRAINTS cc ON cc.CONSTRAINT_SCHEMA = tc.CONSTRAINT_SCHEMA \
         AND cc.TABLE_NAME = tc.TABLE_NAME AND cc.CONSTRAINT_NAME = tc.CONSTRAINT_NAME"
    } else if !server.mariadb && server.at_least(8, 0) {
        "LEFT JOIN information_schema.CHECK_CONSTRAINTS cc ON cc.CONSTRAINT_SCHEMA = tc.CONSTRAINT_SCHEMA \
         AND cc.CONSTRAINT_NAME = tc.CONSTRAINT_NAME"
    } else {
        "LEFT JOIN (SELECT NULL AS CHECK_CLAUSE) cc ON FALSE"
    }
}

/// A table or a view of database `db`.
pub(super) async fn relation(
    connection: &MyConnection,
    db: &str,
    name: &str,
) -> Result<ObjectDescription> {
    let at = [db, name];
    let header = query(
        connection,
        "SELECT CASE TABLE_TYPE WHEN 'BASE TABLE' THEN 'table' WHEN 'SYSTEM VERSIONED' THEN 'table' \
         ELSE LOWER(TABLE_TYPE) END AS Kind, ENGINE AS Engine, TABLE_COLLATION AS Collation, \
         ROW_FORMAT AS `Row format`, AUTO_INCREMENT AS `Auto increment`, TABLE_ROWS AS `Estimated rows`, \
         CONCAT(ROUND((DATA_LENGTH + INDEX_LENGTH) / 1024), ' kB') AS Size, \
         CONCAT(ROUND(DATA_LENGTH / 1024), ' kB') AS `Table size`, CREATE_TIME AS Created, \
         UPDATE_TIME AS Modified, IF(TABLE_TYPE LIKE '%VIEW', NULL, NULLIF(TABLE_COMMENT, '')) AS Comment \
         FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?",
        &at,
    )
    .await?;
    let first = header.rows.first().ok_or_else(unknown)?;
    let view = crate::catalog::text(first, 0).contains("view");
    let mut sections = vec![section(
        "columns",
        "Columns",
        query(
            connection,
            "SELECT ORDINAL_POSITION AS `#`, COLUMN_NAME AS Name, COLUMN_TYPE AS Type, IS_NULLABLE AS Nullable, \
             COLUMN_DEFAULT AS `Default`, NULLIF(EXTRA, '') AS Extra, NULLIF(COLUMN_KEY, '') AS `Key`, \
             COLLATION_NAME AS Collation, NULLIF(COLUMN_COMMENT, '') AS Comment \
             FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION",
            &at,
        )
        .await?,
    )];
    let mut description = described(
        if view { "view" } else { "table" },
        &format!("{db}.{name}"),
        &header,
        Vec::new(),
    );
    // Who may do what with it: on it, and on its whole database. Read only.
    let permissions = section(
        "permissions",
        "Permissions",
        query(
            connection,
            "SELECT GRANTEE AS Grantee, PRIVILEGE_TYPE AS Privilege, IS_GRANTABLE = 'YES' AS Grantable,              'table' AS Scope FROM information_schema.TABLE_PRIVILEGES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?              UNION ALL SELECT GRANTEE, PRIVILEGE_TYPE, IS_GRANTABLE = 'YES', 'database'              FROM information_schema.SCHEMA_PRIVILEGES WHERE TABLE_SCHEMA = ? ORDER BY 4 DESC, 1, 2",
            &[db, name, db],
        )
        .await?,
    );
    if view {
        let definition = query(
            connection,
            "SELECT DEFINER AS Definer, SECURITY_TYPE AS `Security`, CHECK_OPTION AS `Check option`, \
             IS_UPDATABLE AS Updatable, VIEW_DEFINITION AS Definition FROM information_schema.VIEWS \
             WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?",
            &at,
        )
        .await?;
        description.properties.extend(properties(&definition));
        sections.push(permissions);
        description.sections = sections;
        return Ok(description);
    }
    let constraints = format!(
        "SELECT tc.CONSTRAINT_NAME AS Name, LOWER(tc.CONSTRAINT_TYPE) AS Type, \
         (SELECT GROUP_CONCAT(k.COLUMN_NAME ORDER BY k.ORDINAL_POSITION SEPARATOR ', ') \
         FROM information_schema.KEY_COLUMN_USAGE k WHERE k.CONSTRAINT_SCHEMA = tc.CONSTRAINT_SCHEMA \
         AND k.TABLE_NAME = tc.TABLE_NAME AND k.CONSTRAINT_NAME = tc.CONSTRAINT_NAME) AS Columns, \
         cc.CHECK_CLAUSE AS Definition FROM information_schema.TABLE_CONSTRAINTS tc {} \
         WHERE tc.TABLE_SCHEMA = ? AND tc.TABLE_NAME = ? AND tc.CONSTRAINT_TYPE IN ('PRIMARY KEY', 'UNIQUE', 'CHECK') \
         ORDER BY 1",
        checks(connection)
    );
    let foreign = format!(
        "SELECT rc.CONSTRAINT_NAME AS Name, {} AS Columns, rc.UNIQUE_CONSTRAINT_SCHEMA AS `Referenced schema`, \
         rc.REFERENCED_TABLE_NAME AS `Referenced table`, {} AS `Referenced columns`, \
         rc.UPDATE_RULE AS `On update`, rc.DELETE_RULE AS `On delete` \
         FROM information_schema.REFERENTIAL_CONSTRAINTS rc WHERE rc.CONSTRAINT_SCHEMA = ? AND rc.TABLE_NAME = ? \
         ORDER BY 1",
        key_columns(false),
        key_columns(true)
    );
    let referenced = format!(
        "SELECT rc.CONSTRAINT_NAME AS Name, CONCAT(rc.CONSTRAINT_SCHEMA, '.', rc.TABLE_NAME) AS `Table`, \
         {} AS Columns, {} AS `Referenced columns`, rc.CONSTRAINT_SCHEMA AS `Schema`, rc.TABLE_NAME AS `Table name` \
         FROM information_schema.REFERENTIAL_CONSTRAINTS rc WHERE rc.UNIQUE_CONSTRAINT_SCHEMA = ? \
         AND rc.REFERENCED_TABLE_NAME = ? ORDER BY 2, 1",
        key_columns(false),
        key_columns(true)
    );
    let indexes = "SELECT INDEX_NAME AS Name, GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX SEPARATOR ', ') AS Columns, \
         MIN(NON_UNIQUE) = 0 AS `Unique`, MIN(INDEX_TYPE) AS Type, NULLIF(MIN(INDEX_COMMENT), '') AS Comment \
         FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? \
         GROUP BY INDEX_NAME ORDER BY INDEX_NAME = 'PRIMARY' DESC, INDEX_NAME";
    let triggers = "SELECT TRIGGER_NAME AS Name, ACTION_TIMING AS Timing, EVENT_MANIPULATION AS Event, \
         ACTION_STATEMENT AS Statement FROM information_schema.TRIGGERS \
         WHERE EVENT_OBJECT_SCHEMA = ? AND EVENT_OBJECT_TABLE = ? ORDER BY 1";
    let partitions = "SELECT PARTITION_NAME AS Name, PARTITION_METHOD AS Method, \
         PARTITION_DESCRIPTION AS Description, TABLE_ROWS AS `Rows` FROM information_schema.PARTITIONS \
         WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND PARTITION_NAME IS NOT NULL ORDER BY PARTITION_ORDINAL_POSITION";
    for (id, title, sql) in [
        ("constraints", "Constraints", constraints.as_str()),
        ("foreign-keys", "Foreign keys", foreign.as_str()),
        ("references", "Referenced by", referenced.as_str()),
        ("indexes", "Indexes", indexes),
        ("triggers", "Triggers", triggers),
        ("partitions", "Partitions", partitions),
    ] {
        sections.push(section(id, title, query(connection, sql, &at).await?));
    }
    sections.push(permissions);
    description.sections = sections;
    Ok(description)
}
