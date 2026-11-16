//! The children of a node of the tree.
use super::{folders, module_of, node, query, text, unknown};
use crate::connection::SqliteConnection;
use nexo_driver_sdk::{Result, protocol::TreeNode};

const RELATION: &[&str] = &["open", "data", "ddl"];
const CODE: &[&str] = &["open", "ddl"];
const OPEN: &[&str] = &["open"];
/// What a table lists only to be seen: its editor is the table's or the other table's.
const SEEN: &[&str] = &[];

/// The parts of a table or a view, by id: their query (with the table's name bound), the
/// kind of their nodes and what can be done with them.
fn part(part: &str) -> Option<(&'static str, &'static str, &'static [&'static str])> {
    Some(match part {
        "columns" => (
            "SELECT name, type FROM pragma_table_xinfo(?) ORDER BY cid",
            "column",
            OPEN,
        ),
        "foreign-keys" => (
            "SELECT id, group_concat(\"from\", ', ') || ' → ' || \"table\" FROM pragma_foreign_key_list(?) \
             GROUP BY id ORDER BY id",
            "foreign-key",
            SEEN,
        ),
        "indexes" => (
            "SELECT name, CASE origin WHEN 'pk' THEN 'primary key' WHEN 'u' THEN 'unique' \
             ELSE CASE WHEN \"unique\" THEN 'unique' ELSE '' END END FROM pragma_index_list(?) ORDER BY name",
            "index",
            CODE,
        ),
        "references" => (
            "SELECT m.name, '' FROM sqlite_schema m, pragma_foreign_key_list(m.name) f \
             WHERE m.type = 'table' AND f.\"table\" = ? GROUP BY m.name ORDER BY m.name",
            "table",
            SEEN,
        ),
        "triggers" => (
            "SELECT name, '' FROM sqlite_schema WHERE type = 'trigger' AND tbl_name = ? ORDER BY name",
            "trigger",
            CODE,
        ),
        _ => return None,
    })
}

/// The tables of the file: virtual ones with their module, and SQLite's own and the shadow
/// tables of virtual ones hidden by the simple view.
async fn tables(connection: &SqliteConnection) -> Result<Vec<TreeNode>> {
    let rows = query(
        connection,
        "SELECT l.name, l.type, s.sql FROM pragma_table_list l \
         LEFT JOIN sqlite_schema s ON s.type = 'table' AND s.name = l.name \
         WHERE l.schema = 'main' AND l.type <> 'view' ORDER BY l.name",
        &[],
    )
    .await?;
    Ok(rows
        .rows
        .iter()
        .map(|row| {
            let (name, kind) = (text(row, 0), text(row, 1));
            let detail = (kind == "virtual")
                .then(|| module_of(&text(row, 2)))
                .flatten();
            TreeNode {
                system: kind == "shadow" || name.starts_with("sqlite_"),
                ..node("table", &name, detail, true, RELATION)
            }
        })
        .collect())
}

pub(crate) async fn children(
    connection: &SqliteConnection,
    path: &[String],
) -> Result<Vec<TreeNode>> {
    let segments: Vec<&str> = path.iter().map(String::as_str).collect();
    let listed = |rows: crate::session::Rows, kind: &str, children: bool, actions: &[&str]| {
        rows.rows
            .iter()
            .map(|row| {
                let name = text(row, 0);
                let detail = Some(text(row, 1));
                TreeNode {
                    system: name.starts_with("sqlite_"),
                    ..node(kind, &name, detail, children, actions)
                }
            })
            .collect::<Vec<_>>()
    };
    Ok(match segments.as_slice() {
        [] => folders(&[
            ("tables", "Tables"),
            ("views", "Views"),
            ("indexes", "Indexes"),
            ("triggers", "Triggers"),
        ]),
        ["tables"] => tables(connection).await?,
        ["views"] => {
            let sql = "SELECT name, '' FROM sqlite_schema WHERE type = 'view' ORDER BY name";
            listed(query(connection, sql, &[]).await?, "view", true, RELATION)
        }
        ["indexes" | "triggers"] => {
            let (kind, sql) = if segments[0] == "indexes" {
                (
                    "index",
                    "SELECT name, tbl_name FROM sqlite_schema WHERE type = 'index' ORDER BY name",
                )
            } else {
                (
                    "trigger",
                    "SELECT name, tbl_name FROM sqlite_schema WHERE type = 'trigger' ORDER BY name",
                )
            };
            listed(query(connection, sql, &[]).await?, kind, false, CODE)
        }
        ["tables", _] => folders(&[
            ("columns", "Columns"),
            ("foreign-keys", "Foreign keys"),
            ("indexes", "Indexes"),
            ("references", "References"),
            ("triggers", "Triggers"),
        ]),
        ["views", _] => folders(&[("columns", "Columns"), ("triggers", "Triggers")]),
        ["tables" | "views", name, part_id] => {
            let (sql, kind, actions) = part(part_id).ok_or_else(unknown)?;
            let mut nodes = listed(query(connection, sql, &[name]).await?, kind, false, actions);
            // A foreign key of SQLite has no name: its number names it, its columns label it.
            if kind == "foreign-key" {
                for key in &mut nodes {
                    key.label = key.detail.take().unwrap_or_default();
                }
            }
            nodes
        }
        _ => return Err(unknown()),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_part_has_its_query() {
        for id in [
            "columns",
            "foreign-keys",
            "indexes",
            "references",
            "triggers",
        ] {
            assert!(part(id).is_some(), "{id}");
        }
        assert!(part("partitions").is_none());
    }
}
