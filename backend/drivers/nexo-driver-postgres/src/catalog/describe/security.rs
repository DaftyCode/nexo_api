//! A role: its attributes, the roles it belongs to and its members, and the privileges it
//! was granted on the schemas and objects of the database. Read only.
use super::{described, query, section, unknown};
use nexo_driver_sdk::{Result, protocol::ObjectDescription};

/// What a role may do on the schemas and on the tables, views and sequences of the
/// database, as they were granted to it.
const PRIVILEGES: &str = "SELECT * FROM (\
    SELECT n.nspname::text AS \"Schema\", NULL::text AS \"Object\", 'schema' AS \"Kind\", \
    string_agg(a.privilege_type, ', ' ORDER BY a.privilege_type) AS \"Privileges\", \
    bool_or(a.is_grantable) AS \"Grantable\" FROM pg_namespace n \
    CROSS JOIN LATERAL aclexplode(n.nspacl) a JOIN pg_roles r ON r.oid = a.grantee \
    WHERE r.rolname = $1 AND n.nspname NOT LIKE 'pg\\_%' AND n.nspname <> 'information_schema' \
    GROUP BY 1 \
    UNION ALL \
    SELECT n.nspname::text, c.relname::text, CASE c.relkind WHEN 'v' THEN 'view' \
    WHEN 'm' THEN 'materialized view' WHEN 'S' THEN 'sequence' WHEN 'f' THEN 'foreign table' \
    ELSE 'table' END, string_agg(a.privilege_type, ', ' ORDER BY a.privilege_type), \
    bool_or(a.is_grantable) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace \
    CROSS JOIN LATERAL aclexplode(c.relacl) a JOIN pg_roles r ON r.oid = a.grantee \
    WHERE r.rolname = $1 AND c.relkind IN ('r', 'p', 'v', 'm', 'S', 'f') \
    AND n.nspname NOT IN ('pg_catalog', 'information_schema') GROUP BY 1, 2, 3\
    ) p ORDER BY 1, 2 NULLS FIRST";

pub(super) async fn role(client: &tokio_postgres::Client, name: &str) -> Result<ObjectDescription> {
    let params: [&(dyn tokio_postgres::types::ToSql + Sync); 1] = [&name];
    let rows = query(
        client,
        "SELECT rolcanlogin AS \"Can log in\", rolsuper AS \"Superuser\", \
        rolcreatedb AS \"Creates databases\", rolcreaterole AS \"Creates roles\", \
        rolinherit AS \"Inherits\", rolreplication AS \"Replication\", rolbypassrls AS \"Bypasses RLS\", \
        rolconnlimit AS \"Connection limit\", rolvaliduntil::text AS \"Valid until\" \
        FROM pg_roles WHERE rolname = $1",
        &params,
    )
    .await?;
    let row = rows.first().ok_or_else(unknown)?;
    let member_of = query(
        client,
        "SELECT r.rolname::text AS \"Role\", m.admin_option AS \"Admin option\" \
        FROM pg_auth_members m JOIN pg_roles r ON r.oid = m.roleid \
        JOIN pg_roles u ON u.oid = m.member WHERE u.rolname = $1 ORDER BY 1",
        &params,
    )
    .await?;
    let members = query(
        client,
        "SELECT u.rolname::text AS \"Member\", m.admin_option AS \"Admin option\" \
        FROM pg_auth_members m JOIN pg_roles r ON r.oid = m.roleid \
        JOIN pg_roles u ON u.oid = m.member WHERE r.rolname = $1 ORDER BY 1",
        &params,
    )
    .await?;
    let privileges = query(client, PRIVILEGES, &params).await?;
    Ok(described(
        "role",
        name,
        Some(row),
        vec![
            section("member-of", "Member of", &member_of),
            section("members", "Members", &members),
            section("privileges", "Privileges", &privileges),
        ],
    ))
}
