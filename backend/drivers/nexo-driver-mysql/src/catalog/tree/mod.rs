//! The children of a node of the tree.
mod queries;

use super::{SYSTEM_DATABASES, folders, listed, query, unknown};
use crate::connection::MyConnection;
use nexo_driver_sdk::{Result, protocol::TreeNode};
use queries::{folder_sql, part_sql};

pub(super) const OPEN: &[&str] = &["open"];
pub(super) const RELATION: &[&str] = &["open", "data", "ddl"];
pub(super) const CODE: &[&str] = &["open", "ddl"];
/// What a table lists only to be seen: its editor is the table's or the other table's.
pub(super) const SEEN: &[&str] = &[];

/// The folders of a database: those the server has.
fn database_folders(connection: &MyConnection) -> Vec<TreeNode> {
    let mut list = vec![
        ("tables", "Tables"),
        ("views", "Views"),
        ("indexes", "Indexes"),
        ("procedures", "Procedures"),
        ("functions", "Functions"),
        ("triggers", "Triggers"),
        ("events", "Events"),
    ];
    // MariaDB has sequences since 10.3.
    if connection.server.mariadb && connection.server.at_least(10, 3) {
        list.push(("sequences", "Sequences"));
    }
    folders(&list, &[])
}

pub(crate) async fn children(connection: &MyConnection, path: &[String]) -> Result<Vec<TreeNode>> {
    let segments: Vec<&str> = path.iter().map(String::as_str).collect();
    Ok(match segments.as_slice() {
        [] => folders(
            &[
                ("databases", "Databases"),
                ("users", "Users"),
                ("administration", "Administration"),
            ],
            &["users", "administration"],
        ),
        ["databases"] => {
            let rows = query(
                connection,
                "SELECT SCHEMA_NAME FROM information_schema.SCHEMATA ORDER BY \
                 SCHEMA_NAME IN ('mysql', 'information_schema', 'performance_schema', 'sys'), SCHEMA_NAME",
                &[],
            )
            .await?;
            listed(rows, "database", true, CODE, false)
                .into_iter()
                .map(|database| TreeNode {
                    system: SYSTEM_DATABASES.contains(&database.name.as_str()),
                    ..database
                })
                .collect()
        }
        ["databases", _] => database_folders(connection),
        ["databases", db, "indexes"] => {
            let sql = "SELECT CONCAT(TABLE_NAME, '.', INDEX_NAME), INDEX_NAME, TABLE_NAME \
                 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = ? \
                 GROUP BY TABLE_NAME, INDEX_NAME ORDER BY INDEX_NAME, TABLE_NAME";
            listed(
                query(connection, sql, &[db]).await?,
                "index",
                false,
                OPEN,
                true,
            )
        }
        ["databases", db, folder] => {
            let (sql, kind, actions, opens) = folder_sql(folder).ok_or_else(unknown)?;
            listed(
                query(connection, sql, &[db]).await?,
                kind,
                opens,
                actions,
                false,
            )
        }
        ["databases", _, "tables", _] => folders(
            &[
                ("columns", "Columns"),
                ("constraints", "Constraints"),
                ("foreign-keys", "Foreign keys"),
                ("indexes", "Indexes"),
                ("references", "References"),
                ("triggers", "Triggers"),
                ("partitions", "Partitions"),
            ],
            &[],
        ),
        ["databases", _, "views", _] => folders(&[("columns", "Columns")], &[]),
        ["databases", db, "tables" | "views", name, part] => {
            let (sql, kind, actions, labelled) = part_sql(part).ok_or_else(unknown)?;
            listed(
                query(connection, &sql, &[db, name]).await?,
                kind,
                false,
                actions,
                labelled,
            )
        }
        ["users"] => {
            let rows = query(
                connection,
                "SELECT CONCAT(User, '@', Host), CONCAT(User, '@', Host) FROM mysql.user ORDER BY User, Host",
                &[],
            )
            .await?;
            listed(rows, "role", false, CODE, true)
        }
        ["administration"] => folders(
            &[
                ("session-variables", "Session variables"),
                ("global-variables", "Global variables"),
                ("engines", "Engines"),
                ("charsets", "Character sets"),
            ],
            &[],
        ),
        ["administration", folder] => {
            let sql = match *folder {
                "session-variables" => "SHOW SESSION VARIABLES",
                "global-variables" => "SHOW GLOBAL VARIABLES",
                "engines" => {
                    "SELECT ENGINE, LOWER(SUPPORT) FROM information_schema.ENGINES ORDER BY 1"
                }
                "charsets" => {
                    "SELECT CHARACTER_SET_NAME, DEFAULT_COLLATE_NAME \
                     FROM information_schema.CHARACTER_SETS ORDER BY 1"
                }
                _ => return Err(unknown()),
            };
            listed(
                query(connection, sql, &[]).await?,
                "setting",
                false,
                &[],
                false,
            )
        }
        _ => return Err(unknown()),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_folder_and_part_has_its_query() {
        for folder in [
            "tables",
            "views",
            "procedures",
            "functions",
            "triggers",
            "events",
            "sequences",
        ] {
            assert!(folder_sql(folder).is_some(), "{folder}");
        }
        for part in [
            "columns",
            "constraints",
            "foreign-keys",
            "indexes",
            "references",
            "triggers",
            "partitions",
        ] {
            assert!(part_sql(part).is_some(), "{part}");
        }
        assert!(folder_sql("nothing").is_none());
    }
}
