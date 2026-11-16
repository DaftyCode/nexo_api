//! The parts of a table or a view in the tree: columns, keys, indexes, triggers, and what
//! the table lists only to be seen (what uses it, the keys that point to it, its policies).
use super::{CODE, OPEN};
use crate::catalog::{COLUMN_TYPE, object};

/// The query that lists a part (`columns`, `indexes`…) of the table or view `@P1`.`@P2`.
pub(super) fn part_sql(
    db: &str,
    part: &str,
) -> Option<(String, &'static str, &'static [&'static str])> {
    let id = object(db);
    Some(match part {
        "columns" => (
            format!(
                "SELECT c.name, {COLUMN_TYPE} + CASE WHEN c.is_nullable = 0 THEN ' not null' ELSE '' END \
                 FROM {db}.sys.columns c JOIN {db}.sys.types ty ON ty.user_type_id = c.user_type_id \
                 WHERE c.object_id = {id} ORDER BY c.column_id"
            ),
            "column",
            OPEN,
        ),
        "constraints" => (
            format!(
                "SELECT name, LOWER(REPLACE(type_desc, '_', ' ')) FROM {db}.sys.key_constraints WHERE parent_object_id = {id} \
                 UNION ALL SELECT name, 'check' FROM {db}.sys.check_constraints WHERE parent_object_id = {id} ORDER BY 1"
            ),
            "constraint",
            OPEN,
        ),
        "foreign-keys" => (
            format!(
                "SELECT f.name, 'references ' + rs.name + '.' + rt.name FROM {db}.sys.foreign_keys f \
                 JOIN {db}.sys.objects rt ON rt.object_id = f.referenced_object_id \
                 JOIN {db}.sys.schemas rs ON rs.schema_id = rt.schema_id WHERE f.parent_object_id = {id} ORDER BY f.name"
            ),
            "constraint",
            OPEN,
        ),
        "indexes" => (
            format!(
                "SELECT CAST(i.object_id AS varchar(12)) + ':' + CAST(i.index_id AS varchar(12)), i.name, \
                 LOWER(i.type_desc) FROM {db}.sys.indexes i WHERE i.object_id = {id} AND i.name IS NOT NULL ORDER BY i.name"
            ),
            "index",
            CODE,
        ),
        "triggers" => (
            format!(
                "SELECT name, CASE WHEN is_disabled = 1 THEN 'disabled' END FROM {db}.sys.triggers \
                 WHERE parent_id = {id} ORDER BY name"
            ),
            "trigger",
            CODE,
        ),
        // The views, functions and procedures that use the table, listed only to be seen.
        "dependencies" => (
            format!(
                "SELECT DISTINCT s.name + '.' + o.name, o.name, LOWER(REPLACE(o.type_desc, '_', ' ')) \
                 FROM {db}.sys.sql_expression_dependencies d JOIN {db}.sys.objects o ON o.object_id = d.referencing_id \
                 JOIN {db}.sys.schemas s ON s.schema_id = o.schema_id WHERE d.referenced_id = {id} \
                 AND o.type IN ('V', 'FN', 'IF', 'TF', 'P') ORDER BY 1"
            ),
            "dependency",
            &[],
        ),
        // The foreign keys of other tables that point to this one.
        "references" => (
            format!(
                "SELECT rs.name + '.' + rt.name + '.' + f.name, rs.name + '.' + rt.name, f.name \
                 FROM {db}.sys.foreign_keys f JOIN {db}.sys.objects rt ON rt.object_id = f.parent_object_id \
                 JOIN {db}.sys.schemas rs ON rs.schema_id = rt.schema_id WHERE f.referenced_object_id = {id} ORDER BY 2, 3"
            ),
            "reference",
            &[],
        ),
        // The predicates of row-level security policies on the table.
        "policies" => (
            format!(
                "SELECT p.name + ':' + CAST(sp.security_predicate_id AS varchar(12)), p.name, \
                 LOWER(sp.predicate_type_desc) FROM {db}.sys.security_predicates sp \
                 JOIN {db}.sys.security_policies p ON p.object_id = sp.object_id \
                 WHERE sp.target_object_id = {id} ORDER BY 2, 1"
            ),
            "policy",
            &[],
        ),
        _ => return None,
    })
}
