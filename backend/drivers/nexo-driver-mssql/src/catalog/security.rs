//! Who may do what, read only: the server roles of a login and the members of a server role,
//! their permissions on the server, and the permissions on a table or view.
use super::{properties, query, section, unknown};
use crate::connection::MsConnection;
use nexo_driver_sdk::{Result, protocol::ObjectDescription};

/// The permissions granted or denied on the object `id` of database `db`, by principal and,
/// for those of one column, the column.
pub(crate) fn object_permissions(db: &str, id: &str) -> String {
    format!(
        "SELECT pr.name AS Grantee, LOWER(pe.permission_name) AS Permission, \
         LOWER(pe.state_desc) AS State, c.name AS [Column], gr.name AS Grantor \
         FROM {db}.sys.database_permissions pe \
         JOIN {db}.sys.database_principals pr ON pr.principal_id = pe.grantee_principal_id \
         LEFT JOIN {db}.sys.database_principals gr ON gr.principal_id = pe.grantor_principal_id \
         LEFT JOIN {db}.sys.columns c ON c.object_id = pe.major_id AND c.column_id = pe.minor_id \
         WHERE pe.class = 1 AND pe.major_id = {id} ORDER BY 1, 2"
    )
}

/// A login or a server role.
pub(crate) async fn principal(connection: &MsConnection, name: &str) -> Result<ObjectDescription> {
    let found = query(
        connection,
        "SELECT LOWER(REPLACE(type_desc, '_', ' ')) AS Kind, create_date AS Created, \
         is_disabled AS Disabled, default_database_name AS [Default database] \
         FROM sys.server_principals WHERE name = @P1",
        &[name],
    )
    .await?;
    if found.rows.is_empty() {
        return Err(unknown());
    }
    let memberships = "FROM sys.server_role_members m \
        JOIN sys.server_principals r ON r.principal_id = m.role_principal_id \
        JOIN sys.server_principals p ON p.principal_id = m.member_principal_id";
    let member_of = query(
        connection,
        &format!("SELECT r.name AS Role {memberships} WHERE p.name = @P1 ORDER BY 1"),
        &[name],
    )
    .await?;
    let members = query(
        connection,
        &format!(
            "SELECT p.name AS Member, LOWER(REPLACE(p.type_desc, '_', ' ')) AS Kind \
             {memberships} WHERE r.name = @P1 ORDER BY 1"
        ),
        &[name],
    )
    .await?;
    let permissions = query(
        connection,
        "SELECT LOWER(pe.permission_name) AS Permission, LOWER(pe.state_desc) AS State, \
         LOWER(REPLACE(pe.class_desc, '_', ' ')) AS [On], g.name AS Grantor \
         FROM sys.server_permissions pe \
         JOIN sys.server_principals p ON p.principal_id = pe.grantee_principal_id \
         LEFT JOIN sys.server_principals g ON g.principal_id = pe.grantor_principal_id \
         WHERE p.name = @P1 ORDER BY 1",
        &[name],
    )
    .await?;
    Ok(ObjectDescription {
        kind: "role".into(),
        name: name.into(),
        properties: properties(&found),
        sections: vec![
            section("member-of", "Member of", member_of),
            section("members", "Members", members),
            section("permissions", "Permissions", permissions),
        ],
    })
}
