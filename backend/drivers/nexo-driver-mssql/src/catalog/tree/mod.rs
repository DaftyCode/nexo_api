//! The children of a node of the tree.
mod parts;

use super::{SCHEMA_FOLDERS, database, node, query, text, unknown};
use crate::{connection::MsConnection, session::Rows};
use nexo_driver_sdk::{Result, protocol::TreeNode};
use parts::part_sql;

const OPEN: &[&str] = &["open"];
const RELATION: &[&str] = &["open", "data", "ddl"];
const CODE: &[&str] = &["open", "ddl"];

/// Rows of a query as nodes: name in the first column, label in the second (or the name),
/// detail in the last.
fn listed(
    rows: Rows,
    kind: &str,
    children: bool,
    actions: &[&str],
    labelled: bool,
) -> Vec<TreeNode> {
    rows.rows
        .iter()
        .map(|row| {
            let name = text(row, 0);
            let label = if labelled { text(row, 1) } else { name.clone() };
            let detail = Some(text(row, row.len() - 1))
                .filter(|detail| !detail.is_empty() && row.len() > 1 + labelled as usize);
            node(kind, &name, &label, detail, children, actions)
        })
        .collect()
}

fn folders(list: &[(&str, &str)], system: &[&str]) -> Vec<TreeNode> {
    list.iter()
        .map(|(id, label)| TreeNode {
            system: system.contains(id),
            ..node("folder", id, label, None, true, &[])
        })
        .collect()
}

/// The query that lists a folder of schema `@P1` of database `db`.
fn folder_sql(db: &str, folder: &str) -> Option<String> {
    let in_schema =
        format!("JOIN {db}.sys.schemas s ON s.schema_id = o.schema_id WHERE s.name = @P1");
    Some(match folder {
        "tables" => format!(
            "SELECT o.name, CAST((SELECT SUM(p.rows) FROM {db}.sys.partitions p WHERE p.object_id = o.object_id \
             AND p.index_id IN (0, 1)) AS nvarchar(30)) + ' rows' FROM {db}.sys.tables o {in_schema} ORDER BY o.name"
        ),
        "views" => format!("SELECT o.name FROM {db}.sys.views o {in_schema} ORDER BY o.name"),
        "procedures" => {
            format!("SELECT o.name FROM {db}.sys.procedures o {in_schema} ORDER BY o.name")
        }
        "functions" => format!(
            "SELECT o.name, LOWER(REPLACE(o.type_desc, '_', ' ')) FROM {db}.sys.objects o {in_schema} \
             AND o.type IN ('FN', 'IF', 'TF', 'FS', 'FT', 'AF') ORDER BY o.name"
        ),
        "sequences" => format!(
            "SELECT o.name, ty.name FROM {db}.sys.sequences o JOIN {db}.sys.types ty ON ty.user_type_id = o.user_type_id \
             {in_schema} ORDER BY o.name"
        ),
        "synonyms" => format!(
            "SELECT o.name, o.base_object_name FROM {db}.sys.synonyms o {in_schema} ORDER BY o.name"
        ),
        "types" => format!(
            "SELECT o.name, CASE WHEN o.is_table_type = 1 THEN 'table type' ELSE b.name END FROM {db}.sys.types o \
             LEFT JOIN {db}.sys.types b ON b.user_type_id = o.system_type_id {in_schema} AND o.is_user_defined = 1 ORDER BY o.name"
        ),
        "triggers" => format!(
            "SELECT tr.name, o.name FROM {db}.sys.triggers tr JOIN {db}.sys.objects o ON o.object_id = tr.parent_id \
             {in_schema} ORDER BY tr.name"
        ),
        "indexes" => format!(
            "SELECT CAST(i.object_id AS varchar(12)) + ':' + CAST(i.index_id AS varchar(12)), i.name, o.name \
             FROM {db}.sys.indexes i JOIN {db}.sys.tables o ON o.object_id = i.object_id {in_schema} \
             AND i.name IS NOT NULL ORDER BY i.name"
        ),
        _ => return None,
    })
}

pub(crate) async fn children(connection: &MsConnection, path: &[String]) -> Result<Vec<TreeNode>> {
    let segments: Vec<&str> = path.iter().map(String::as_str).collect();
    Ok(match segments.as_slice() {
        [] => folders(
            &[
                ("databases", "Databases"),
                ("security", "Security"),
                ("administration", "Administration"),
            ],
            &["security", "administration"],
        ),
        ["databases"] => {
            let rows = query(
                connection,
                "SELECT name, CASE WHEN state_desc <> 'ONLINE' THEN LOWER(state_desc) END, database_id \
                 FROM sys.databases ORDER BY CASE WHEN database_id <= 4 THEN 1 ELSE 0 END, name",
                &[],
            )
            .await?;
            rows.rows
                .iter()
                .map(|row| TreeNode {
                    system: text(row, 2).parse::<i64>().is_ok_and(|id| id <= 4),
                    ..node(
                        "database",
                        &text(row, 0),
                        &text(row, 0),
                        Some(text(row, 1)).filter(|d| !d.is_empty()),
                        true,
                        OPEN,
                    )
                })
                .collect()
        }
        ["databases", _] => folders(&[("schemas", "Schemas")], &[]),
        ["databases", db, "schemas"] => {
            let db = database(db);
            let rows = query(
                connection,
                &format!(
                    "SELECT name FROM {db}.sys.schemas WHERE schema_id < 16384 \
                     ORDER BY CASE WHEN name IN ('sys', 'INFORMATION_SCHEMA', 'guest') THEN 1 ELSE 0 END, name"
                ),
                &[],
            )
            .await?;
            listed(rows, "schema", true, CODE, false)
                .into_iter()
                .map(|schema| TreeNode {
                    system: matches!(schema.name.as_str(), "sys" | "INFORMATION_SCHEMA" | "guest"),
                    ..schema
                })
                .collect()
        }
        ["databases", _, "schemas", _] => folders(
            &SCHEMA_FOLDERS
                .iter()
                .map(|(id, label, _)| (*id, *label))
                .collect::<Vec<_>>(),
            &[],
        ),
        ["databases", db, "schemas", schema, folder] => {
            let sql = folder_sql(&database(db), folder).ok_or_else(unknown)?;
            let kind = SCHEMA_FOLDERS
                .iter()
                .find(|(id, ..)| id == folder)
                .map_or("object", |(.., kind)| *kind);
            let rows = query(connection, &sql, &[schema]).await?;
            match *folder {
                "tables" => listed(rows, kind, true, RELATION, false),
                "views" => listed(rows, kind, true, RELATION, false),
                "indexes" => listed(rows, kind, false, CODE, true),
                "sequences" | "synonyms" | "types" => listed(rows, kind, false, OPEN, false),
                _ => listed(rows, kind, false, CODE, false),
            }
        }
        ["databases", _, "schemas", _, "tables", _] => folders(
            &[
                ("columns", "Columns"),
                ("constraints", "Constraints"),
                ("foreign-keys", "Foreign keys"),
                ("indexes", "Indexes"),
                ("dependencies", "Dependencies"),
                ("references", "References"),
                ("triggers", "Triggers"),
                ("policies", "Policies"),
            ],
            &[],
        ),
        ["databases", _, "schemas", _, "views", _] => {
            folders(&[("columns", "Columns"), ("indexes", "Indexes")], &[])
        }
        [
            "databases",
            db,
            "schemas",
            schema,
            "tables" | "views",
            name,
            part,
        ] => {
            let (sql, kind, actions) = part_sql(&database(db), part).ok_or_else(unknown)?;
            let rows = query(connection, &sql, &[schema, name]).await?;
            let labelled = matches!(
                *part,
                "indexes" | "dependencies" | "references" | "policies"
            );
            listed(rows, kind, false, actions, labelled)
        }
        ["security"] => folders(&[("logins", "Logins"), ("roles", "Server roles")], &[]),
        ["security", folder @ ("logins" | "roles")] => {
            let types = if *folder == "logins" {
                "'S', 'U', 'G', 'E', 'X'"
            } else {
                "'R'"
            };
            let sql = format!(
                "SELECT name, LOWER(REPLACE(type_desc, '_', ' ')) FROM sys.server_principals \
                 WHERE type IN ({types}) AND name NOT LIKE '##%' ORDER BY name"
            );
            listed(
                query(connection, &sql, &[]).await?,
                "role",
                false,
                OPEN,
                false,
            )
        }
        ["administration"] => folders(&[("configuration", "Configuration")], &[]),
        ["administration", "configuration"] => {
            let sql = "SELECT name, CAST(value_in_use AS nvarchar(64)) FROM sys.configurations ORDER BY name";
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
