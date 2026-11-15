//! What an object is like: its properties and sections, from the catalog views.
use super::{COLUMN_TYPE, database, object, properties, query, section, text, unknown};
use crate::connection::MsConnection;
use nexo_driver_sdk::{Result, protocol::ObjectDescription};

/// The columns of a key of `fc` (`sys.foreign_key_columns`) on side `side` (`parent` or
/// `referenced`), in order.
fn key_columns(db: &str, side: &str) -> String {
    format!(
        "(SELECT STRING_AGG(kc.name, ', ') WITHIN GROUP (ORDER BY fc.constraint_column_id) \
         FROM {db}.sys.foreign_key_columns fc JOIN {db}.sys.columns kc ON kc.object_id = fc.{side}_object_id \
         AND kc.column_id = fc.{side}_column_id WHERE fc.constraint_object_id = f.object_id)"
    )
}

/// The columns of index `i`, in order, with `DESC` where it applies; `included` for the
/// columns it only carries.
pub(crate) fn index_columns(db: &str, included: bool) -> String {
    let (filter, order) = if included {
        ("ic.is_included_column = 1", "ic.index_column_id")
    } else {
        (
            "ic.is_included_column = 0 AND ic.key_ordinal > 0",
            "ic.key_ordinal",
        )
    };
    format!(
        "(SELECT STRING_AGG(QUOTENAME(col.name){desc}, ', ') WITHIN GROUP (ORDER BY {order}) \
         FROM {db}.sys.index_columns ic JOIN {db}.sys.columns col ON col.object_id = ic.object_id AND col.column_id = ic.column_id \
         WHERE ic.object_id = i.object_id AND ic.index_id = i.index_id AND {filter})",
        desc = if included {
            ""
        } else {
            " + CASE WHEN ic.is_descending_key = 1 THEN ' DESC' ELSE '' END"
        }
    )
}

/// The foreign keys from (`parent`) or to (`referenced`) the object `{id}`.
fn keys(db: &str, id: &str, toward: bool) -> String {
    let (filter, other, names) = if toward {
        (
            "f.referenced_object_id",
            "f.parent_object_id",
            "AS [Schema], ot.name AS [Table name]",
        )
    } else {
        (
            "f.parent_object_id",
            "f.referenced_object_id",
            "AS [Referenced schema], ot.name AS [Referenced table]",
        )
    };
    let label = if toward { "Table" } else { "References" };
    let (columns, referenced) = (key_columns(db, "parent"), key_columns(db, "referenced"));
    format!(
        "SELECT f.name AS Name, os.name + '.' + ot.name AS [{label}], \
         'FOREIGN KEY (' + {columns} + ') REFERENCES ' + rs.name + '.' + rt.name + ' (' + {referenced} + ')' AS Definition, \
         {columns} AS Columns, {referenced} AS [Referenced columns], os.name {names} \
         FROM {db}.sys.foreign_keys f JOIN {db}.sys.objects ot ON ot.object_id = {other} \
         JOIN {db}.sys.schemas os ON os.schema_id = ot.schema_id \
         JOIN {db}.sys.objects rt ON rt.object_id = f.referenced_object_id JOIN {db}.sys.schemas rs ON rs.schema_id = rt.schema_id \
         WHERE {filter} = {id} ORDER BY 2, 1"
    )
}

/// A table or view.
async fn relation(
    connection: &MsConnection,
    db: &str,
    schema: &str,
    name: &str,
) -> Result<ObjectDescription> {
    let id = object(db);
    let header = format!(
        "SELECT LOWER(REPLACE(o.type_desc, '_', ' ')) AS Kind, ISNULL(op.name, sp.name) AS Owner, \
         o.create_date AS Created, o.modify_date AS Modified, \
         (SELECT SUM(p.rows) FROM {db}.sys.partitions p WHERE p.object_id = o.object_id AND p.index_id IN (0, 1)) AS [Estimated rows], \
         CAST((SELECT SUM(a.total_pages) * 8 FROM {db}.sys.partitions p JOIN {db}.sys.allocation_units a \
         ON a.container_id = p.partition_id WHERE p.object_id = o.object_id) AS nvarchar(30)) + ' KB' AS Size, \
         CAST((SELECT TOP 1 e.value FROM {db}.sys.extended_properties e WHERE e.class = 1 AND e.major_id = o.object_id \
         AND e.minor_id = 0 AND e.name = 'MS_Description') AS nvarchar(4000)) AS Comment, m.definition AS Definition \
         FROM {db}.sys.objects o JOIN {db}.sys.schemas s ON s.schema_id = o.schema_id \
         LEFT JOIN {db}.sys.database_principals op ON op.principal_id = o.principal_id \
         LEFT JOIN {db}.sys.database_principals sp ON sp.principal_id = s.principal_id \
         LEFT JOIN {db}.sys.sql_modules m ON m.object_id = o.object_id WHERE s.name = @P1 AND o.name = @P2"
    );
    let found = query(connection, &header, &[schema, name]).await?;
    let row = found.rows.first().ok_or_else(unknown)?;
    let view = text(row, 0).contains("view");
    let columns = format!(
        "SELECT c.column_id AS [#], c.name AS Name, {COLUMN_TYPE} AS Type, c.is_nullable AS Nullable, \
         dc.definition AS [Default], CASE WHEN ic.object_id IS NOT NULL THEN 'IDENTITY(' + CAST(ic.seed_value AS varchar(40)) \
         + ',' + CAST(ic.increment_value AS varchar(40)) + ')' END AS [Identity], cc.definition AS Computed, \
         CAST(ep.value AS nvarchar(4000)) AS Comment FROM {db}.sys.columns c \
         JOIN {db}.sys.types ty ON ty.user_type_id = c.user_type_id \
         LEFT JOIN {db}.sys.default_constraints dc ON dc.parent_object_id = c.object_id AND dc.parent_column_id = c.column_id \
         LEFT JOIN {db}.sys.identity_columns ic ON ic.object_id = c.object_id AND ic.column_id = c.column_id \
         LEFT JOIN {db}.sys.computed_columns cc ON cc.object_id = c.object_id AND cc.column_id = c.column_id \
         LEFT JOIN {db}.sys.extended_properties ep ON ep.class = 1 AND ep.major_id = c.object_id \
         AND ep.minor_id = c.column_id AND ep.name = 'MS_Description' WHERE c.object_id = {id} ORDER BY c.column_id"
    );
    let constraints = format!(
        "SELECT k.name AS Name, LOWER(REPLACE(k.type_desc, '_', ' ')) AS Type, {cols} AS Definition \
         FROM {db}.sys.key_constraints k JOIN {db}.sys.indexes i ON i.object_id = k.parent_object_id AND i.index_id = k.unique_index_id \
         WHERE k.parent_object_id = {id} \
         UNION ALL SELECT ch.name, 'check', ch.definition FROM {db}.sys.check_constraints ch WHERE ch.parent_object_id = {id} ORDER BY 1",
        cols = index_columns(db, false)
    );
    let indexes = format!(
        "SELECT i.name AS Name, LOWER(i.type_desc) AS Type, i.is_unique AS [Unique], i.is_primary_key AS [Primary], \
         {keys} AS Columns, {included} AS Included, i.filter_definition AS Filter \
         FROM {db}.sys.indexes i WHERE i.object_id = {id} AND i.name IS NOT NULL ORDER BY i.name",
        keys = index_columns(db, false),
        included = index_columns(db, true)
    );
    let triggers = format!(
        "SELECT tr.name AS Name, CAST(1 - tr.is_disabled AS bit) AS Enabled, m.definition AS Definition \
         FROM {db}.sys.triggers tr LEFT JOIN {db}.sys.sql_modules m ON m.object_id = tr.object_id \
         WHERE tr.parent_id = {id} ORDER BY tr.name"
    );
    let mut list = vec![
        ("columns", "Columns", columns),
        ("indexes", "Indexes", indexes),
    ];
    if !view {
        list.splice(
            1..1,
            [
                ("constraints", "Constraints", constraints),
                ("foreign-keys", "Foreign keys", keys(db, &id, false)),
                ("references", "Referenced by", keys(db, &id, true)),
            ],
        );
        list.push(("triggers", "Triggers", triggers));
    }
    let mut sections = Vec::new();
    for (key, title, sql) in list {
        sections.push(section(
            key,
            title,
            query(connection, &sql, &[schema, name]).await?,
        ));
    }
    Ok(ObjectDescription {
        kind: if view { "view" } else { "table" }.into(),
        name: format!("{schema}.{name}"),
        properties: properties(&found),
        sections,
    })
}

/// One row of properties of an object, from a query on `@P1` (schema) and `@P2` (name).
async fn single(
    connection: &MsConnection,
    kind: &str,
    name: String,
    sql: &str,
    params: &[&str],
) -> Result<ObjectDescription> {
    let found = query(connection, sql, params).await?;
    if found.rows.is_empty() {
        return Err(unknown());
    }
    Ok(ObjectDescription {
        kind: kind.into(),
        name,
        properties: properties(&found),
        sections: Vec::new(),
    })
}

pub(crate) async fn describe(
    connection: &MsConnection,
    path: &[String],
) -> Result<ObjectDescription> {
    let segments: Vec<&str> = path.iter().map(String::as_str).collect();
    match segments.as_slice() {
        ["databases", name] => single(
            connection,
            "database",
            (*name).into(),
            "SELECT collation_name AS Collation, recovery_model_desc AS [Recovery model], compatibility_level AS Compatibility, \
             state_desc AS State, create_date AS Created, is_read_only AS [Read-only], snapshot_isolation_state_desc AS [Snapshot isolation] \
             FROM sys.databases WHERE name = @P1",
            &[name],
        )
        .await,
        ["databases", db, "schemas", schema] => {
            let db = database(db);
            let mut described = single(
                connection,
                "schema",
                (*schema).into(),
                &format!(
                    "SELECT p.name AS Owner FROM {db}.sys.schemas s JOIN {db}.sys.database_principals p \
                     ON p.principal_id = s.principal_id WHERE s.name = @P1"
                ),
                &[schema],
            )
            .await?;
            let counts = format!(
                "SELECT LOWER(REPLACE(o.type_desc, '_', ' ')) AS Kind, COUNT(*) AS Objects FROM {db}.sys.objects o \
                 JOIN {db}.sys.schemas s ON s.schema_id = o.schema_id WHERE s.name = @P1 AND o.is_ms_shipped = 0 \
                 AND o.parent_object_id = 0 GROUP BY o.type_desc ORDER BY 1"
            );
            described.sections = vec![section("objects", "Objects", query(connection, &counts, &[schema]).await?)];
            Ok(described)
        }
        ["databases", db, "schemas", schema, "tables" | "views", name] => relation(connection, &database(db), schema, name).await,
        ["databases", db, "schemas", schema, "procedures" | "functions" | "triggers", name] => {
            let db = database(db);
            single(
                connection,
                if segments[4] == "triggers" { "trigger" } else { "function" },
                format!("{schema}.{name}"),
                &format!(
                    "SELECT LOWER(REPLACE(o.type_desc, '_', ' ')) AS Kind, o.create_date AS Created, o.modify_date AS Modified, \
                     m.definition AS Definition FROM {db}.sys.objects o JOIN {db}.sys.schemas s ON s.schema_id = o.schema_id \
                     LEFT JOIN {db}.sys.sql_modules m ON m.object_id = o.object_id WHERE s.name = @P1 AND o.name = @P2"
                ),
                &[schema, name],
            )
            .await
        }
        ["databases", db, "schemas", schema, "sequences", name] => {
            let db = database(db);
            single(
                connection,
                "sequence",
                format!("{schema}.{name}"),
                &format!(
                    "SELECT ty.name AS Type, q.start_value AS Start, q.increment AS Increment, q.minimum_value AS Minimum, \
                     q.maximum_value AS Maximum, q.current_value AS [Current], q.is_cycling AS Cycles FROM {db}.sys.sequences q \
                     JOIN {db}.sys.schemas s ON s.schema_id = q.schema_id JOIN {db}.sys.types ty ON ty.user_type_id = q.user_type_id \
                     WHERE s.name = @P1 AND q.name = @P2"
                ),
                &[schema, name],
            )
            .await
        }
        ["databases", db, "schemas", schema, "tables" | "views", name, "columns", column] => {
            let db = database(db);
            let id = object(&db);
            single(
                connection,
                "column",
                (*column).into(),
                &format!(
                    "SELECT {COLUMN_TYPE} AS Type, c.is_nullable AS Nullable, c.collation_name AS Collation, \
                     c.is_identity AS [Identity], cc.definition AS Computed, CAST(ep.value AS nvarchar(4000)) AS Comment \
                     FROM {db}.sys.columns c JOIN {db}.sys.types ty ON ty.user_type_id = c.user_type_id \
                     LEFT JOIN {db}.sys.computed_columns cc ON cc.object_id = c.object_id AND cc.column_id = c.column_id \
                     LEFT JOIN {db}.sys.extended_properties ep ON ep.class = 1 AND ep.major_id = c.object_id \
                     AND ep.minor_id = c.column_id AND ep.name = 'MS_Description' WHERE c.object_id = {id} AND c.name = @P3"
                ),
                &[schema, name, column],
            )
            .await
        }
        ["security", "logins" | "roles", name] => single(
            connection,
            "role",
            (*name).into(),
            "SELECT LOWER(REPLACE(type_desc, '_', ' ')) AS Kind, create_date AS Created, is_disabled AS Disabled, \
             default_database_name AS [Default database] FROM sys.server_principals WHERE name = @P1",
            &[name],
        )
        .await,
        [.., item] if !item.is_empty() => Ok(ObjectDescription {
            kind: "object".into(),
            name: (*item).into(),
            ..ObjectDescription::default()
        }),
        _ => Err(unknown()),
    }
}
