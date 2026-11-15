//! The DDL of an object. SQL Server keeps the code of views, procedures, functions and
//! triggers (`sys.sql_modules`); a table's `CREATE TABLE` is rebuilt from the catalog, with
//! its columns, keys, checks, defaults, foreign keys, indexes and descriptions.
use super::describe::index_columns;
use super::{COLUMN_TYPE, database, object, query, text, unknown};
use crate::{connection::MsConnection, dialect::quoted};
use nexo_driver_sdk::{Result, Value, protocol::Ddl};

fn literal(text: &str) -> String {
    format!("N'{}'", text.replace('\'', "''"))
}

/// `sp_addextendedproperty` for a description of the table or of one of its columns.
fn description(schema: &str, table: &str, column: Option<&str>, value: &str) -> String {
    let column = column.map_or(String::new(), |name| {
        format!(", @level2type = N'COLUMN', @level2name = {}", literal(name))
    });
    format!(
        "EXEC sys.sp_addextendedproperty @name = N'MS_Description', @value = {}, @level0type = N'SCHEMA', \
         @level0name = {}, @level1type = N'TABLE', @level1name = {}{column}",
        literal(value),
        literal(schema),
        literal(table)
    )
}

/// The `CREATE INDEX` of the indexes of `filter` (not those of keys, made with the table).
async fn indexes(
    connection: &MsConnection,
    db: &str,
    filter: &str,
    params: &[&str],
) -> Result<Vec<String>> {
    let sql = format!(
        "SELECT s.name, o.name, i.name, i.is_unique, LOWER(i.type_desc), {keys}, {included}, i.filter_definition \
         FROM {db}.sys.indexes i JOIN {db}.sys.objects o ON o.object_id = i.object_id \
         JOIN {db}.sys.schemas s ON s.schema_id = o.schema_id \
         WHERE {filter} AND i.name IS NOT NULL AND i.is_primary_key = 0 AND i.is_unique_constraint = 0 ORDER BY i.name",
        keys = index_columns(db, false),
        included = index_columns(db, true)
    );
    let rows = query(connection, &sql, params).await?;
    Ok(rows
        .rows
        .iter()
        .map(|row| {
            let unique = if row[3] == Value::Bool(true) {
                "UNIQUE "
            } else {
                ""
            };
            let included = Some(text(row, 6)).filter(|list| !list.is_empty());
            let filter = Some(text(row, 7)).filter(|filter| !filter.is_empty());
            format!(
                "CREATE {unique}{} INDEX {} ON {}.{} ({}){}{}",
                text(row, 4).to_uppercase(),
                quoted(&text(row, 2)),
                quoted(&text(row, 0)),
                quoted(&text(row, 1)),
                text(row, 5),
                included.map_or(String::new(), |list| format!(" INCLUDE ({list})")),
                filter.map_or(String::new(), |filter| format!(" WHERE {filter}")),
            )
        })
        .collect())
}

async fn table(connection: &MsConnection, db: &str, schema: &str, name: &str) -> Result<String> {
    let id = object(db);
    let columns = query(
        connection,
        &format!(
            "SELECT c.name, {COLUMN_TYPE}, c.is_nullable, CAST(ic.seed_value AS varchar(40)), CAST(ic.increment_value AS varchar(40)), \
             cc.definition, cc.is_persisted, dc.name, dc.definition, CAST(ep.value AS nvarchar(4000)) \
             FROM {db}.sys.columns c JOIN {db}.sys.types ty ON ty.user_type_id = c.user_type_id \
             LEFT JOIN {db}.sys.identity_columns ic ON ic.object_id = c.object_id AND ic.column_id = c.column_id \
             LEFT JOIN {db}.sys.computed_columns cc ON cc.object_id = c.object_id AND cc.column_id = c.column_id \
             LEFT JOIN {db}.sys.default_constraints dc ON dc.parent_object_id = c.object_id AND dc.parent_column_id = c.column_id \
             LEFT JOIN {db}.sys.extended_properties ep ON ep.class = 1 AND ep.major_id = c.object_id \
             AND ep.minor_id = c.column_id AND ep.name = 'MS_Description' WHERE c.object_id = {id} ORDER BY c.column_id"
        ),
        &[schema, name],
    )
    .await?;
    if columns.rows.is_empty() {
        return Err(unknown());
    }
    let mut lines = Vec::new();
    let mut comments = Vec::new();
    for row in &columns.rows {
        let mut line = format!("    {} ", quoted(&text(row, 0)));
        if let Some(computed) = Some(text(row, 5)).filter(|definition| !definition.is_empty()) {
            line.push_str(&format!("AS {computed}"));
            if row[6] == Value::Bool(true) {
                line.push_str(" PERSISTED");
            }
        } else {
            line.push_str(&text(row, 1));
            if !text(row, 3).is_empty() {
                line.push_str(&format!(" IDENTITY({},{})", text(row, 3), text(row, 4)));
            }
            line.push_str(if row[2] == Value::Bool(true) {
                " NULL"
            } else {
                " NOT NULL"
            });
            if !text(row, 7).is_empty() {
                line.push_str(&format!(
                    " CONSTRAINT {} DEFAULT {}",
                    quoted(&text(row, 7)),
                    text(row, 8)
                ));
            }
        }
        lines.push(line);
        if !text(row, 9).is_empty() {
            comments.push(description(
                schema,
                name,
                Some(&text(row, 0)),
                &text(row, 9),
            ));
        }
    }
    let keys = query(
        connection,
        &format!(
            "SELECT k.name, k.type, LOWER(i.type_desc), {cols} FROM {db}.sys.key_constraints k \
             JOIN {db}.sys.indexes i ON i.object_id = k.parent_object_id AND i.index_id = k.unique_index_id \
             WHERE k.parent_object_id = {id} ORDER BY k.type, k.name \
             ",
            cols = index_columns(db, false)
        ),
        &[schema, name],
    )
    .await?;
    for row in &keys.rows {
        let kind = if text(row, 1) == "PK" {
            "PRIMARY KEY"
        } else {
            "UNIQUE"
        };
        lines.push(format!(
            "    CONSTRAINT {} {kind} {} ({})",
            quoted(&text(row, 0)),
            text(row, 2).to_uppercase(),
            text(row, 3)
        ));
    }
    let checks = query(
        connection,
        &format!("SELECT name, definition FROM {db}.sys.check_constraints WHERE parent_object_id = {id} ORDER BY name"),
        &[schema, name],
    )
    .await?;
    for row in &checks.rows {
        lines.push(format!(
            "    CONSTRAINT {} CHECK {}",
            quoted(&text(row, 0)),
            text(row, 1)
        ));
    }
    let target = format!("{}.{}", quoted(schema), quoted(name));
    let mut statements = vec![format!("CREATE TABLE {target} (\n{}\n)", lines.join(",\n"))];
    let foreign = query(
        connection,
        &format!(
            "SELECT f.name, rs.name, rt.name, \
             (SELECT STRING_AGG(QUOTENAME(pc.name), ', ') WITHIN GROUP (ORDER BY fc.constraint_column_id) FROM {db}.sys.foreign_key_columns fc \
             JOIN {db}.sys.columns pc ON pc.object_id = fc.parent_object_id AND pc.column_id = fc.parent_column_id WHERE fc.constraint_object_id = f.object_id), \
             (SELECT STRING_AGG(QUOTENAME(rc.name), ', ') WITHIN GROUP (ORDER BY fc.constraint_column_id) FROM {db}.sys.foreign_key_columns fc \
             JOIN {db}.sys.columns rc ON rc.object_id = fc.referenced_object_id AND rc.column_id = fc.referenced_column_id WHERE fc.constraint_object_id = f.object_id), \
             f.delete_referential_action_desc, f.update_referential_action_desc FROM {db}.sys.foreign_keys f \
             JOIN {db}.sys.objects rt ON rt.object_id = f.referenced_object_id JOIN {db}.sys.schemas rs ON rs.schema_id = rt.schema_id \
             WHERE f.parent_object_id = {id} ORDER BY f.name"
        ),
        &[schema, name],
    )
    .await?;
    for row in &foreign.rows {
        let action = |index: usize, word: &str| match text(row, index).as_str() {
            "NO_ACTION" | "" => String::new(),
            other => format!(" ON {word} {}", other.replace('_', " ")),
        };
        statements.push(format!(
            "ALTER TABLE {target} ADD CONSTRAINT {} FOREIGN KEY ({}) REFERENCES {}.{} ({}){}{}",
            quoted(&text(row, 0)),
            text(row, 3),
            quoted(&text(row, 1)),
            quoted(&text(row, 2)),
            text(row, 4),
            action(5, "DELETE"),
            action(6, "UPDATE"),
        ));
    }
    statements.extend(
        indexes(
            connection,
            db,
            &format!("i.object_id = {id}"),
            &[schema, name],
        )
        .await?,
    );
    let comment = query(
        connection,
        &format!(
            "SELECT CAST(value AS nvarchar(4000)) FROM {db}.sys.extended_properties WHERE class = 1 AND major_id = {id} \
             AND minor_id = 0 AND name = 'MS_Description'"
        ),
        &[schema, name],
    )
    .await?;
    if let Some(row) = comment.rows.first() {
        statements.push(description(schema, name, None, &text(row, 0)));
    }
    statements.extend(comments);
    Ok(statements.join(";\n") + ";")
}

pub(crate) async fn ddl(connection: &MsConnection, path: &[String]) -> Result<Ddl> {
    let segments: Vec<&str> = path.iter().map(String::as_str).collect();
    let sql = match segments.as_slice() {
        ["databases", db, "schemas", schema] => {
            let db = database(db);
            let rows = query(
                connection,
                &format!(
                    "SELECT p.name FROM {db}.sys.schemas s JOIN {db}.sys.database_principals p ON p.principal_id = s.principal_id WHERE s.name = @P1"
                ),
                &[schema],
            )
            .await?;
            let owner = rows
                .rows
                .first()
                .map(|row| text(row, 0))
                .ok_or_else(unknown)?;
            format!(
                "CREATE SCHEMA {} AUTHORIZATION {};",
                quoted(schema),
                quoted(&owner)
            )
        }
        ["databases", db, "schemas", schema, "tables", name] => {
            table(connection, &database(db), schema, name).await?
        }
        [
            "databases",
            db,
            "schemas",
            schema,
            "views" | "procedures" | "functions" | "triggers",
            name,
        ] => {
            let db = database(db);
            let rows = query(
                connection,
                &format!(
                    "SELECT m.definition FROM {db}.sys.sql_modules m WHERE m.object_id = {}",
                    object(&db)
                ),
                &[schema, name],
            )
            .await?;
            rows.rows
                .first()
                .map(|row| text(row, 0))
                .filter(|code| !code.is_empty())
                .ok_or_else(unknown)?
        }
        [
            "databases",
            db,
            "schemas",
            _,
            "indexes" | "tables" | "views",
            ..,
            id,
        ] if id.contains(':') => {
            let db = database(db);
            let (table, index) = id.split_once(':').ok_or_else(unknown)?;
            let (table, index): (i64, i64) = (
                table.parse().map_err(|_| unknown())?,
                index.parse().map_err(|_| unknown())?,
            );
            let filter = format!("i.object_id = {table} AND i.index_id = {index}");
            let mut found = indexes(connection, &db, &filter, &[]).await?;
            if found.is_empty() {
                return Err(nexo_driver_sdk::DriverError::invalid(
                    "This index belongs to a key: its DDL is the table's",
                ));
            }
            found.remove(0) + ";"
        }
        _ => return Err(unknown()),
    };
    Ok(Ddl { sql })
}
