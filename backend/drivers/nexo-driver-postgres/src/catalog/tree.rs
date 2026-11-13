//! The children of a node of the tree.
use super::{RELATION, SCHEMA_FOLDERS, database_of, node, query, text, unknown};
use crate::connection::PgConnection;
use nexo_driver_sdk::{Result, protocol::TreeNode};

const OPEN: &[&str] = &["open"];
const RELATION_ACTIONS: &[&str] = &["open", "data", "ddl"];
const CODE_ACTIONS: &[&str] = &["open", "ddl"];

/// Rows estimated by the statistics, as a node's detail.
fn rows_detail(rows: f32) -> Option<String> {
    (rows >= 0.0).then(|| format!("~{} rows", rows as u64))
}

/// The condition that picks the functions of a folder, before and after PostgreSQL 11.
fn routines(folder: &str, version: i32) -> &'static str {
    match (folder, version >= 110000) {
        ("functions", true) => "p.prokind IN ('f', 'w')",
        ("procedures", true) => "p.prokind = 'p'",
        ("aggregates", true) => "p.prokind = 'a'",
        ("functions", false) => "NOT p.proisagg",
        ("aggregates", false) => "p.proisagg",
        _ => "false",
    }
}

fn relkinds(folder: &str) -> &'static str {
    match folder {
        "tables" => "'r', 'p'",
        "foreign-tables" => "'f'",
        "views" => "'v'",
        "materialized-views" => "'m'",
        "sequences" => "'S'",
        _ => "''",
    }
}

pub(crate) async fn children(connection: &PgConnection, path: &[String]) -> Result<Vec<TreeNode>> {
    let segments: Vec<&str> = path.iter().map(String::as_str).collect();
    if segments.is_empty() {
        let listed = query(&connection.main.client, "SELECT datname::text FROM pg_database \
            WHERE datallowconn AND NOT datistemplate ORDER BY datname = current_database() DESC, datname", &[]).await;
        // Without the right to list them, the connection's own database is enough.
        let names = match listed {
            Ok(rows) => rows.iter().map(|row| text(row, 0)).collect(),
            Err(_) => vec![connection.database.clone()],
        };
        return Ok(names
            .iter()
            .map(|name| node("database", name, name, None, true, OPEN))
            .collect());
    }
    let (_, client) = database_of(connection, path).await?;
    let version = connection.version;
    let listed = |rows: Vec<tokio_postgres::Row>,
                  kind: &str,
                  children: bool,
                  actions: &[&str]|
     -> Vec<TreeNode> {
        rows.iter()
            .map(|row| {
                let (name, label) = (text(row, 0), text(row, 1));
                let detail = Some(text(row, 2)).filter(|detail| !detail.is_empty());
                node(kind, &name, &label, detail, children, actions)
            })
            .collect()
    };
    Ok(match segments.as_slice() {
        [_] => [("schemas", "Schemas"), ("extensions", "Extensions"), ("roles", "Roles"), ("tablespaces", "Tablespaces")]
            .iter()
            .map(|(id, label)| node("folder", id, label, None, true, &[]))
            .collect(),
        [_, "schemas"] => listed(query(&client, "SELECT nspname::text, nspname::text, \
            CASE WHEN nspname IN ('pg_catalog', 'information_schema') THEN 'system' END \
            FROM pg_namespace WHERE nspname NOT LIKE 'pg\\_toast%' AND nspname NOT LIKE 'pg\\_temp\\_%' \
            ORDER BY nspname IN ('pg_catalog', 'information_schema'), nspname", &[]).await?, "schema", true, CODE_ACTIONS),
        [_, "extensions"] => listed(query(&client, "SELECT extname::text, extname::text, extversion FROM pg_extension ORDER BY 1", &[]).await?, "extension", false, CODE_ACTIONS),
        [_, "roles"] => listed(query(&client, "SELECT rolname::text, rolname::text, CASE WHEN rolcanlogin THEN 'login' ELSE 'group' END \
            FROM pg_roles WHERE rolname NOT LIKE 'pg\\_%' ORDER BY 1", &[]).await?, "role", false, CODE_ACTIONS),
        [_, "tablespaces"] => listed(query(&client, "SELECT spcname::text, spcname::text, NULL::text FROM pg_tablespace ORDER BY 1", &[]).await?, "tablespace", false, OPEN),
        [_, "schemas", _] => SCHEMA_FOLDERS
            .iter()
            .map(|(id, label, _)| node("folder", id, label, None, true, &[]))
            .collect(),
        [_, "schemas", schema, folder @ ("tables" | "foreign-tables" | "views" | "materialized-views" | "sequences")] => {
            let partition = match *folder {
                "tables" if version >= 100000 => "AND NOT c.relispartition",
                // The sequences of identity columns belong to them, as pg_dump sees them.
                "sequences" => "AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = c.oid                     AND d.classid = 'pg_class'::regclass AND d.deptype = 'i')",
                _ => "",
            };
            let sql = format!("SELECT c.relname::text, c.relname::text, c.reltuples::float4 FROM pg_class c \
                JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND c.relkind IN ({}) {partition} ORDER BY 1", relkinds(folder));
            let rows = query(&client, &sql, &[schema]).await?;
            let (kind, children, actions) = match *folder {
                "sequences" => ("sequence", false, CODE_ACTIONS),
                "views" | "materialized-views" => ("view", true, RELATION_ACTIONS),
                _ => ("table", true, RELATION_ACTIONS),
            };
            rows.iter()
                .map(|row| {
                    let name = text(row, 0);
                    let detail = if kind == "table" { rows_detail(row.get(2)) } else { None };
                    node(kind, &name, &name, detail, children, actions)
                })
                .collect()
        }
        [_, "schemas", schema, "indexes"] => listed(query(&client, "SELECT i.relname::text, i.relname::text, t.relname::text \
            FROM pg_index x JOIN pg_class i ON i.oid = x.indexrelid JOIN pg_class t ON t.oid = x.indrelid \
            JOIN pg_namespace n ON n.oid = i.relnamespace WHERE n.nspname = $1 ORDER BY 1", &[schema]).await?, "index", false, CODE_ACTIONS),
        [_, "schemas", schema, folder @ ("functions" | "procedures" | "aggregates")] => {
            let sql = format!("SELECT p.oid::text, p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')', \
                pg_get_function_result(p.oid) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace \
                WHERE n.nspname = $1 AND {} ORDER BY 2", routines(folder, version));
            let kind = &folder[..folder.len() - 1];
            listed(query(&client, &sql, &[schema]).await?, kind, false, CODE_ACTIONS)
        }
        [_, "schemas", schema, "types"] => listed(query(&client, "SELECT t.typname::text, t.typname::text, \
            CASE t.typtype WHEN 'e' THEN 'enum' WHEN 'c' THEN 'composite' WHEN 'd' THEN 'domain' WHEN 'r' THEN 'range' END \
            FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace WHERE n.nspname = $1 AND t.typtype IN ('e', 'c', 'd', 'r') \
            AND (t.typtype <> 'c' OR (SELECT relkind FROM pg_class WHERE oid = t.typrelid) = 'c') ORDER BY 1", &[schema]).await?, "type", false, CODE_ACTIONS),
        [_, "schemas", _, "tables" | "foreign-tables", _] => {
            let mut parts = vec![("columns", "Columns"), ("constraints", "Constraints"), ("foreign-keys", "Foreign keys"),
                ("indexes", "Indexes"), ("triggers", "Triggers")];
            if version >= 100000 {
                parts.push(("partitions", "Partitions"));
            }
            parts.iter().map(|(id, label)| node("folder", id, label, None, true, &[])).collect()
        }
        [_, "schemas", _, "views" | "materialized-views", _] => vec![node("folder", "columns", "Columns", None, true, &[])],
        [_, "schemas", schema, _, table, part] => {
            let sql = match *part {
                "columns" => format!("SELECT a.attname::text, a.attname::text, format_type(a.atttypid, a.atttypmod) \
                    || CASE WHEN a.attnotnull THEN ' not null' ELSE '' END FROM pg_attribute a \
                    WHERE a.attrelid = {RELATION} AND a.attnum > 0 AND NOT a.attisdropped ORDER BY a.attnum"),
                "constraints" => format!("SELECT conname::text, conname::text, CASE contype WHEN 'p' THEN 'primary key' \
                    WHEN 'u' THEN 'unique' WHEN 'c' THEN 'check' WHEN 'x' THEN 'exclusion' END FROM pg_constraint \
                    WHERE conrelid = {RELATION} AND contype IN ('p', 'u', 'c', 'x') ORDER BY 1"),
                "foreign-keys" => format!("SELECT conname::text, conname::text, 'references ' || confrelid::regclass::text \
                    FROM pg_constraint WHERE conrelid = {RELATION} AND contype = 'f' ORDER BY 1"),
                "indexes" => format!("SELECT i.relname::text, i.relname::text, am.amname::text FROM pg_index x \
                    JOIN pg_class i ON i.oid = x.indexrelid JOIN pg_am am ON am.oid = i.relam WHERE x.indrelid = {RELATION} ORDER BY 1"),
                "triggers" => format!("SELECT tgname::text, tgname::text, NULL::text FROM pg_trigger \
                    WHERE tgrelid = {RELATION} AND NOT tgisinternal ORDER BY 1"),
                "partitions" => format!("SELECT c.relname::text, c.relname::text, pg_get_expr(c.relpartbound, c.oid) \
                    FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid WHERE i.inhparent = {RELATION} ORDER BY 1"),
                _ => return Err(unknown()),
            };
            let kind = match *part {
                "columns" => "column",
                "constraints" | "foreign-keys" => "constraint",
                "indexes" => "index",
                "triggers" => "trigger",
                _ => "table",
            };
            let children = *part == "partitions";
            let actions = if children { RELATION_ACTIONS } else { CODE_ACTIONS };
            listed(query(&client, &sql, &[schema, table]).await?, kind, children, actions)
        }
        _ => return Err(unknown()),
    })
}
