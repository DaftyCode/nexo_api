//! A relation (table, view…): its header, its lists, and who may do what with it.
use super::{described, query, section, unknown};
use crate::catalog::RELATION;
use nexo_driver_sdk::{Result, protocol::ObjectDescription};

/// The relation (table, view…) of `schema.name`.
pub(super) async fn relation(
    client: &tokio_postgres::Client,
    version: i32,
    schema: &str,
    name: &str,
) -> Result<ObjectDescription> {
    let params: [&(dyn tokio_postgres::types::ToSql + Sync); 2] = [&schema, &name];
    let header = format!(
        "SELECT CASE c.relkind WHEN 'r' THEN 'table' WHEN 'p' THEN 'partitioned table' \
        WHEN 'f' THEN 'foreign table' WHEN 'v' THEN 'view' WHEN 'm' THEN 'materialized view' ELSE c.relkind::text END AS \"Kind\", \
        pg_get_userbyid(c.relowner)::text AS \"Owner\", obj_description(c.oid, 'pg_class') AS \"Comment\", \
        CASE WHEN c.reltuples >= 0 THEN c.reltuples::int8 END AS \"Estimated rows\", \
        pg_size_pretty(pg_total_relation_size(c.oid)) AS \"Size\", \
        pg_size_pretty(pg_relation_size(c.oid)) AS \"Table size\", c.oid::int8 AS \"Object ID\", \
        CASE c.relpersistence WHEN 'p' THEN 'permanent' WHEN 'u' THEN 'unlogged' WHEN 't' THEN 'temporary' END \
        AS \"Persistence\", GREATEST(s.last_vacuum, s.last_autovacuum) AS \"Last vacuum\", \
        GREATEST(s.last_analyze, s.last_autoanalyze) AS \"Last analyze\", \
        CASE WHEN c.relkind IN ('v', 'm') THEN pg_get_viewdef(c.oid, true) END AS \"Definition\" \
        FROM pg_class c LEFT JOIN pg_stat_all_tables s ON s.relid = c.oid WHERE c.oid = {RELATION}"
    );
    let rows = query(client, &header, &params).await?;
    let row = rows.first().ok_or_else(unknown)?;
    let identity = if version >= 100000 {
        "NULLIF(a.attidentity, '')::text"
    } else {
        "NULL::text"
    };
    let columns = format!(
        "SELECT a.attnum AS \"#\", a.attname::text AS \"Name\", format_type(a.atttypid, a.atttypmod) AS \"Type\", \
        NOT a.attnotnull AS \"Nullable\", pg_get_expr(d.adbin, d.adrelid) AS \"Default\", {identity} AS \"Identity\", \
        col_description(a.attrelid, a.attnum) AS \"Comment\" FROM pg_attribute a \
        LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum \
        WHERE a.attrelid = {RELATION} AND a.attnum > 0 AND NOT a.attisdropped ORDER BY a.attnum"
    );
    let constraints = format!(
        "SELECT conname::text AS \"Name\", CASE contype WHEN 'p' THEN 'primary key' WHEN 'u' THEN 'unique' \
        WHEN 'c' THEN 'check' WHEN 'x' THEN 'exclusion' END AS \"Type\", pg_get_constraintdef(oid) AS \"Definition\" \
        FROM pg_constraint WHERE conrelid = {RELATION} AND contype IN ('p', 'u', 'c', 'x') ORDER BY 1"
    );
    // The columns of both ends, in order, so the interface can follow a key without reading
    // its definition.
    let ends = "(SELECT string_agg(a.attname, ', ' ORDER BY k.n) FROM unnest(f.conkey) WITH ORDINALITY k(attnum, n) \
        JOIN pg_attribute a ON a.attrelid = f.conrelid AND a.attnum = k.attnum) AS \"Columns\", \
        (SELECT string_agg(a.attname, ', ' ORDER BY k.n) FROM unnest(f.confkey) WITH ORDINALITY k(attnum, n) \
        JOIN pg_attribute a ON a.attrelid = f.confrelid AND a.attnum = k.attnum) AS \"Referenced columns\"";
    let foreign = format!(
        "SELECT f.conname::text AS \"Name\", f.confrelid::regclass::text AS \"References\", \
        pg_get_constraintdef(f.oid) AS \"Definition\", {ends}, rn.nspname::text AS \"Referenced schema\", \
        rc.relname::text AS \"Referenced table\" FROM pg_constraint f \
        JOIN pg_class rc ON rc.oid = f.confrelid JOIN pg_namespace rn ON rn.oid = rc.relnamespace \
        WHERE f.conrelid = {RELATION} AND f.contype = 'f' ORDER BY 1"
    );
    let referenced = format!(
        "SELECT f.conname::text AS \"Name\", f.conrelid::regclass::text AS \"Table\", \
        pg_get_constraintdef(f.oid) AS \"Definition\", {ends}, cn.nspname::text AS \"Schema\", \
        cc.relname::text AS \"Table name\" FROM pg_constraint f \
        JOIN pg_class cc ON cc.oid = f.conrelid JOIN pg_namespace cn ON cn.oid = cc.relnamespace \
        WHERE f.confrelid = {RELATION} AND f.contype = 'f' ORDER BY 2, 1"
    );
    let indexes = format!(
        "SELECT i.relname::text AS \"Name\", pg_get_indexdef(x.indexrelid) AS \"Definition\", \
        x.indisunique AS \"Unique\", x.indisprimary AS \"Primary\", pg_size_pretty(pg_relation_size(i.oid)) AS \"Size\" \
        FROM pg_index x JOIN pg_class i ON i.oid = x.indexrelid WHERE x.indrelid = {RELATION} ORDER BY 1"
    );
    let triggers = format!(
        "SELECT tgname::text AS \"Name\", pg_get_triggerdef(oid, true) AS \"Definition\", \
        tgenabled <> 'D' AS \"Enabled\" FROM pg_trigger WHERE tgrelid = {RELATION} AND NOT tgisinternal ORDER BY 1"
    );
    // Who may do what with it: its grants, or its owner's defaults when it has none.
    let permissions = format!(
        "SELECT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee)::text END AS \"Grantee\",         a.privilege_type AS \"Privilege\", a.is_grantable AS \"Grantable\",         pg_get_userbyid(a.grantor)::text AS \"Grantor\" FROM pg_class c         CROSS JOIN LATERAL aclexplode(COALESCE(c.relacl, acldefault('r', c.relowner))) a         WHERE c.oid = {RELATION} ORDER BY 1, 2"
    );
    let mut sections = Vec::new();
    for (id, title, sql) in [
        ("columns", "Columns", &columns),
        ("constraints", "Constraints", &constraints),
        ("foreign-keys", "Foreign keys", &foreign),
        ("references", "Referenced by", &referenced),
        ("indexes", "Indexes", &indexes),
        ("triggers", "Triggers", &triggers),
        ("permissions", "Permissions", &permissions),
    ] {
        sections.push(section(id, title, &query(client, sql, &params).await?));
    }
    let kind = if matches!(
        crate::catalog::text(row, 0).as_str(),
        "view" | "materialized view"
    ) {
        "view"
    } else {
        "table"
    };
    Ok(described(
        kind,
        &format!("{schema}.{name}"),
        Some(row),
        sections,
    ))
}
