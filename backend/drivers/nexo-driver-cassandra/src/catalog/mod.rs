//! The tree of a cluster, read from `system_schema`: keyspaces (with their replication), and
//! in each its tables, materialized views, user types, functions, aggregates and indexes; a
//! table's columns mark the partition key, the clustering key with its order, and the static
//! ones. The roles of the cluster are in a folder of their own.
mod columns;
mod ddl;
mod describe;

pub(crate) use columns::{columns, key_role, replication};

pub(crate) use ddl::ddl;
pub(crate) use describe::describe;

use crate::connection::{rows, text};
use nexo_driver_sdk::{DriverError, Result, protocol::TreeNode};
use scylla::client::session::Session;

/// The folder of the roles; no keyspace name has a dot.
pub(crate) const ROLES: &str = ".roles";
/// Keyspaces of the server itself, which the simple view hides.
const SYSTEM: [&str; 8] = [
    "system",
    "system_auth",
    "system_schema",
    "system_distributed",
    "system_distributed_everywhere",
    "system_traces",
    "system_views",
    "system_virtual_schema",
];
const FOLDERS: [(&str, &str); 6] = [
    ("tables", "Tables"),
    ("views", "Materialized views"),
    ("types", "User types"),
    ("functions", "Functions"),
    ("aggregates", "Aggregates"),
    ("indexes", "Indexes"),
];

fn node(
    kind: &str,
    name: &str,
    detail: Option<String>,
    children: bool,
    actions: &[&str],
) -> TreeNode {
    TreeNode {
        kind: kind.into(),
        name: name.into(),
        label: name.into(),
        detail: detail.filter(|detail| !detail.is_empty()),
        has_children: children,
        actions: actions.iter().map(|action| (*action).to_owned()).collect(),
        system: false,
    }
}
fn folder(name: &str, label: &str) -> TreeNode {
    TreeNode {
        label: label.into(),
        ..node("folder", name, None, true, &[])
    }
}
pub(crate) fn unknown() -> DriverError {
    DriverError::invalid("There is no such object in the tree")
}

/// The names in the first column of a catalog query of a keyspace.
async fn names(session: &Session, cql: &str, keyspace: &str) -> Result<Vec<String>> {
    let (_, rows) = rows(session, cql, &[keyspace]).await?;
    let mut names: Vec<String> = rows.iter().map(|row| text(row, 0)).collect();
    names.sort();
    names.dedup();
    Ok(names)
}

pub(crate) async fn tree(session: &Session, path: &[String]) -> Result<Vec<TreeNode>> {
    let path: Vec<&str> = path.iter().map(String::as_str).collect();
    Ok(match path.as_slice() {
        [] => {
            let (_, rows) = rows(
                session,
                "SELECT keyspace_name, replication FROM system_schema.keyspaces",
                &[],
            )
            .await?;
            let mut keyspaces: Vec<TreeNode> = rows
                .iter()
                .map(|row| {
                    let name = text(row, 0);
                    TreeNode {
                        system: SYSTEM.contains(&name.as_str()),
                        ..node("schema", &name, Some(replication(&row[1])), true, &["ddl"])
                    }
                })
                .collect();
            keyspaces.sort_by(|a, b| a.system.cmp(&b.system).then(a.name.cmp(&b.name)));
            keyspaces.push(TreeNode {
                system: true,
                ..folder(ROLES, "Roles")
            });
            keyspaces
        }
        [ROLES] => {
            let (_, rows) = rows(
                session,
                "SELECT role, is_superuser, can_login FROM system_auth.roles",
                &[],
            )
            .await?;
            let mut roles: Vec<TreeNode> = rows
                .iter()
                .map(|row| {
                    let detail = match (text(row, 1).as_str(), text(row, 2).as_str()) {
                        ("true", _) => "superuser",
                        (_, "true") => "login",
                        _ => "",
                    };
                    node("role", &text(row, 0), Some(detail.into()), false, &[])
                })
                .collect();
            roles.sort_by(|a, b| a.name.cmp(&b.name));
            roles
        }
        [_] => FOLDERS
            .iter()
            .map(|(name, label)| folder(name, label))
            .collect(),
        [keyspace, "tables"] => names(
            session,
            "SELECT table_name FROM system_schema.tables WHERE keyspace_name = ?",
            keyspace,
        )
        .await?
        .iter()
        .map(|name| node("table", name, None, true, &["open", "data", "ddl"]))
        .collect(),
        [keyspace, "views"] => names(
            session,
            "SELECT view_name FROM system_schema.views WHERE keyspace_name = ?",
            keyspace,
        )
        .await?
        .iter()
        .map(|name| node("view", name, None, true, &["open", "data", "ddl"]))
        .collect(),
        [keyspace, "types"] => names(
            session,
            "SELECT type_name FROM system_schema.types WHERE keyspace_name = ?",
            keyspace,
        )
        .await?
        .iter()
        .map(|name| node("type", name, None, false, &["open", "ddl"]))
        .collect(),
        [keyspace, "functions"] => names(
            session,
            "SELECT function_name FROM system_schema.functions WHERE keyspace_name = ?",
            keyspace,
        )
        .await?
        .iter()
        .map(|name| node("function", name, None, false, &["open", "ddl"]))
        .collect(),
        [keyspace, "aggregates"] => names(
            session,
            "SELECT aggregate_name FROM system_schema.aggregates WHERE keyspace_name = ?",
            keyspace,
        )
        .await?
        .iter()
        .map(|name| node("aggregate", name, None, false, &["open", "ddl"]))
        .collect(),
        [keyspace, "indexes"] => {
            let (_, rows) = rows(
                session,
                "SELECT index_name, table_name FROM system_schema.indexes WHERE keyspace_name = ?",
                &[keyspace],
            )
            .await?;
            rows.iter()
                .map(|row| node("index", &text(row, 0), Some(text(row, 1)), false, &["ddl"]))
                .collect()
        }
        [_, "tables", _] => vec![folder("columns", "Columns"), folder("indexes", "Indexes")],
        [_, "views", _] => vec![folder("columns", "Columns")],
        [keyspace, "tables" | "views", table, "columns"] => columns(session, keyspace, table)
            .await?
            .iter()
            .map(|row| {
                let role = key_role(row);
                let detail = if role.is_empty() {
                    text(row, 1)
                } else {
                    format!("{} · {role}", text(row, 1))
                };
                node("column", &text(row, 0), Some(detail), false, &[])
            })
            .collect(),
        [keyspace, "tables", table, "indexes"] => {
            let (_, rows) = rows(
                session,
                "SELECT index_name, kind FROM system_schema.indexes WHERE keyspace_name = ? AND table_name = ?",
                &[keyspace, table],
            )
            .await?;
            rows.iter()
                .map(|row| {
                    node(
                        "index",
                        &text(row, 0),
                        Some(text(row, 1).to_lowercase()),
                        false,
                        &["ddl"],
                    )
                })
                .collect()
        }
        _ => return Err(unknown()),
    })
}
