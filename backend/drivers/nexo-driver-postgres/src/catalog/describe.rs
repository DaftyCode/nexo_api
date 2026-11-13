//! What an object is like: its properties and its lists, named in the queries themselves so
//! the interface shows them without knowing PostgreSQL.
use super::{RELATION, database_of, properties, query, section, unknown};
use crate::connection::PgConnection;
use nexo_driver_sdk::{Result, protocol::ObjectDescription};
use tokio_postgres::Row;

fn described(
    kind: &str,
    name: &str,
    row: Option<&Row>,
    sections: Vec<nexo_driver_sdk::protocol::Section>,
) -> ObjectDescription {
    ObjectDescription {
        kind: kind.into(),
        name: name.into(),
        properties: row.map(properties).unwrap_or_default(),
        sections,
    }
}

/// The relation (table, view…) of `schema.name`.
async fn relation(
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
        CASE WHEN c.relkind IN ('v', 'm') THEN pg_get_viewdef(c.oid, true) END AS \"Definition\" \
        FROM pg_class c WHERE c.oid = {RELATION}"
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
    let foreign = format!(
        "SELECT conname::text AS \"Name\", confrelid::regclass::text AS \"References\", \
        pg_get_constraintdef(oid) AS \"Definition\" FROM pg_constraint WHERE conrelid = {RELATION} AND contype = 'f' ORDER BY 1"
    );
    let referenced = format!(
        "SELECT conname::text AS \"Name\", conrelid::regclass::text AS \"Table\", \
        pg_get_constraintdef(oid) AS \"Definition\" FROM pg_constraint WHERE confrelid = {RELATION} AND contype = 'f' ORDER BY 2, 1"
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
    let mut sections = Vec::new();
    for (id, title, sql) in [
        ("columns", "Columns", &columns),
        ("constraints", "Constraints", &constraints),
        ("foreign-keys", "Foreign keys", &foreign),
        ("references", "Referenced by", &referenced),
        ("indexes", "Indexes", &indexes),
        ("triggers", "Triggers", &triggers),
    ] {
        sections.push(section(id, title, &query(client, sql, &params).await?));
    }
    let kind = if matches!(super::text(row, 0).as_str(), "view" | "materialized view") {
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

pub(crate) async fn describe(
    connection: &PgConnection,
    path: &[String],
) -> Result<ObjectDescription> {
    let path = super::resolved(path);
    let (database, client) = database_of(connection, &path).await?;
    let segments: Vec<&str> = path.iter().map(String::as_str).collect();
    let one = |rows: Vec<Row>| rows.into_iter().next().ok_or_else(unknown);
    Ok(match segments.as_slice() {
        [_] => {
            let row = one(query(&client, "SELECT pg_get_userbyid(datdba)::text AS \"Owner\", \
                pg_encoding_to_char(encoding) AS \"Encoding\", datcollate::text AS \"Collation\", \
                pg_size_pretty(pg_database_size(oid)) AS \"Size\", datconnlimit AS \"Connection limit\" \
                FROM pg_database WHERE datname = $1", &[&database]).await?)?;
            described("database", database, Some(&row), Vec::new())
        }
        [_, "schemas", schema] => {
            let row = one(query(&client, "SELECT pg_get_userbyid(nspowner)::text AS \"Owner\", \
                obj_description(oid, 'pg_namespace') AS \"Comment\" FROM pg_namespace WHERE nspname = $1", &[schema]).await?)?;
            let counts = query(&client, "SELECT CASE c.relkind WHEN 'r' THEN 'Tables' WHEN 'p' THEN 'Tables' \
                WHEN 'v' THEN 'Views' WHEN 'm' THEN 'Materialized views' WHEN 'S' THEN 'Sequences' WHEN 'f' THEN 'Foreign tables' \
                WHEN 'i' THEN 'Indexes' WHEN 'I' THEN 'Indexes' ELSE 'Other' END AS \"Kind\", count(*) AS \"Objects\" \
                FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 GROUP BY 1 ORDER BY 1", &[schema]).await?;
            described(
                "schema",
                schema,
                Some(&row),
                vec![section("objects", "Objects", &counts)],
            )
        }
        [
            _,
            "schemas",
            schema,
            "tables" | "foreign-tables" | "views" | "materialized-views",
            name,
        ] => relation(&client, connection.version, schema, name).await?,
        [
            _,
            "schemas",
            _,
            "functions" | "procedures" | "aggregates",
            oid,
        ] => {
            let oid: u32 = oid.parse().map_err(|_| unknown())?;
            let definition = if connection.version >= 110000 {
                "CASE WHEN p.prokind <> 'a' THEN pg_get_functiondef(p.oid) END"
            } else {
                "CASE WHEN NOT p.proisagg THEN pg_get_functiondef(p.oid) END"
            };
            let sql = format!(
                "SELECT p.proname::text AS \"Name\", pg_get_function_arguments(p.oid) AS \"Arguments\", \
                pg_get_function_result(p.oid) AS \"Returns\", l.lanname::text AS \"Language\", \
                CASE p.provolatile WHEN 'i' THEN 'immutable' WHEN 's' THEN 'stable' ELSE 'volatile' END AS \"Volatility\", \
                pg_get_userbyid(p.proowner)::text AS \"Owner\", obj_description(p.oid, 'pg_proc') AS \"Comment\", \
                {definition} AS \"Definition\" FROM pg_proc p JOIN pg_language l ON l.oid = p.prolang WHERE p.oid = $1"
            );
            let row = one(query(&client, &sql, &[&oid]).await?)?;
            described(
                &segments[3][..segments[3].len() - 1],
                &super::text(&row, 0),
                Some(&row),
                Vec::new(),
            )
        }
        [_, "schemas", schema, "sequences", name] => {
            let sql = if connection.version >= 100000 {
                "SELECT data_type::text AS \"Type\", start_value AS \"Start\", min_value AS \"Minimum\", max_value AS \"Maximum\", \
                 increment_by AS \"Increment\", cycle AS \"Cycles\", cache_size AS \"Cache\", last_value AS \"Last value\" \
                 FROM pg_sequences WHERE schemaname = $1 AND sequencename = $2"
            } else {
                "SELECT c.relname::text AS \"Name\" FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace \
                 WHERE n.nspname = $1 AND c.relname = $2"
            };
            let row = one(query(&client, sql, &[schema, name]).await?)?;
            described(
                "sequence",
                &format!("{schema}.{name}"),
                Some(&row),
                Vec::new(),
            )
        }
        [_, "schemas", schema, "types", name] => {
            let row = one(query(&client, "SELECT CASE t.typtype WHEN 'e' THEN 'enum' WHEN 'c' THEN 'composite' \
                WHEN 'd' THEN 'domain' WHEN 'r' THEN 'range' ELSE t.typtype::text END AS \"Kind\", \
                pg_get_userbyid(t.typowner)::text AS \"Owner\", obj_description(t.oid, 'pg_type') AS \"Comment\", \
                CASE WHEN t.typtype = 'd' THEN format_type(t.typbasetype, t.typtypmod) END AS \"Base type\" \
                FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace WHERE n.nspname = $1 AND t.typname = $2", &[schema, name]).await?)?;
            let labels = query(&client, "SELECT e.enumlabel::text AS \"Value\" FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid \
                JOIN pg_namespace n ON n.oid = t.typnamespace WHERE n.nspname = $1 AND t.typname = $2 ORDER BY e.enumsortorder", &[schema, name]).await?;
            let fields = query(&client, "SELECT a.attname::text AS \"Name\", format_type(a.atttypid, a.atttypmod) AS \"Type\" \
                FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace JOIN pg_attribute a ON a.attrelid = t.typrelid \
                WHERE n.nspname = $1 AND t.typname = $2 AND a.attnum > 0 AND NOT a.attisdropped ORDER BY a.attnum", &[schema, name]).await?;
            described(
                "type",
                &format!("{schema}.{name}"),
                Some(&row),
                vec![
                    section("values", "Values", &labels),
                    section("fields", "Fields", &fields),
                ],
            )
        }
        [_, "schemas", schema, "indexes", name] => {
            let row = one(query(&client, "SELECT x.indrelid::regclass::text AS \"Table\", pg_get_indexdef(x.indexrelid) AS \"Definition\", \
                x.indisunique AS \"Unique\", pg_size_pretty(pg_relation_size(i.oid)) AS \"Size\" FROM pg_index x \
                JOIN pg_class i ON i.oid = x.indexrelid JOIN pg_namespace n ON n.oid = i.relnamespace \
                WHERE n.nspname = $1 AND i.relname = $2", &[schema, name]).await?)?;
            described("index", &format!("{schema}.{name}"), Some(&row), Vec::new())
        }
        [_, "extensions", name] => {
            let row = one(query(
                &client,
                "SELECT e.extversion AS \"Version\", n.nspname::text AS \"Schema\", \
                obj_description(e.oid, 'pg_extension') AS \"Comment\" FROM pg_extension e \
                JOIN pg_namespace n ON n.oid = e.extnamespace WHERE e.extname = $1",
                &[name],
            )
            .await?)?;
            described("extension", name, Some(&row), Vec::new())
        }
        [_, "roles", name] => {
            let row = one(query(&client, "SELECT rolcanlogin AS \"Can log in\", rolsuper AS \"Superuser\", \
                rolcreatedb AS \"Creates databases\", rolcreaterole AS \"Creates roles\", rolconnlimit AS \"Connection limit\", \
                rolvaliduntil::text AS \"Valid until\" FROM pg_roles WHERE rolname = $1", &[name]).await?)?;
            described("role", name, Some(&row), Vec::new())
        }
        [_, "tablespaces", name] => {
            let row = one(query(
                &client,
                "SELECT pg_get_userbyid(spcowner)::text AS \"Owner\", \
                pg_tablespace_location(oid) AS \"Location\" FROM pg_tablespace WHERE spcname = $1",
                &[name],
            )
            .await?)?;
            described("tablespace", name, Some(&row), Vec::new())
        }
        [_, "schemas", schema, _, table, part, item] => {
            let whole = relation(&client, connection.version, schema, table).await?;
            let section = whole
                .sections
                .into_iter()
                .find(|section| section.id == *part)
                .ok_or_else(unknown)?;
            let name_column = section
                .columns
                .iter()
                .position(|column| column == "Name")
                .ok_or_else(unknown)?;
            let row = section
                .rows
                .into_iter()
                .find(|row| {
                    row.get(name_column) == Some(&nexo_driver_sdk::Value::Text((*item).to_owned()))
                })
                .ok_or_else(unknown)?;
            let properties = section
                .columns
                .iter()
                .zip(row)
                .filter(|(_, value)| *value != nexo_driver_sdk::Value::Null)
                .map(|(name, value)| nexo_driver_sdk::protocol::Property {
                    name: name.clone(),
                    value,
                })
                .collect();
            ObjectDescription {
                kind: part.trim_end_matches('s').into(),
                name: (*item).into(),
                properties,
                sections: Vec::new(),
            }
        }
        _ => return Err(unknown()),
    })
}
