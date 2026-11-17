//! The structure editor of SQL Server: the model of a table read from `sys` of its database,
//! the types a column may take (also the user's), and the DDL of each change ([`writer`]).
#[cfg(test)]
mod tests;
pub(crate) mod writer;

use crate::{
    catalog::{database, object, query, text},
    connection::MsConnection,
};
use nexo_driver_sdk::{
    DriverError, Result, Value,
    ddl::{CheckModel, ColumnModel, DdlModel, ForeignKeyModel, IndexModel, KeyModel, TableModel},
};
use std::collections::BTreeMap;

/// A type as a column is declared with it: `nvarchar(50)`, `decimal(10,2)`, `datetime2(7)`.
const TYPE: &str = "CASE WHEN t.name IN ('varchar', 'char', 'varbinary', 'binary') \
      THEN t.name + '(' + CASE WHEN c.max_length = -1 THEN 'max' ELSE CAST(c.max_length AS varchar) END + ')' \
    WHEN t.name IN ('nvarchar', 'nchar') \
      THEN t.name + '(' + CASE WHEN c.max_length = -1 THEN 'max' ELSE CAST(c.max_length / 2 AS varchar) END + ')' \
    WHEN t.name IN ('decimal', 'numeric') \
      THEN t.name + '(' + CAST(c.precision AS varchar) + ',' + CAST(c.scale AS varchar) + ')' \
    WHEN t.name IN ('datetime2', 'time', 'datetimeoffset') THEN t.name + '(' + CAST(c.scale AS varchar) + ')' \
    ELSE t.name END";

fn yes(value: Option<&Value>) -> bool {
    matches!(value, Some(Value::Bool(true) | Value::Integer(1)))
}

/// `((0))` → `(0)`: a default as SQL Server keeps it, without the parentheses it adds.
pub(crate) fn unwrapped(definition: &str) -> String {
    let definition = definition.trim();
    match definition
        .strip_prefix('(')
        .and_then(|rest| rest.strip_suffix(')'))
    {
        Some(inner) => inner.to_owned(),
        None => definition.to_owned(),
    }
}

/// `NO_ACTION` → empty, `SET_NULL` → `SET NULL`.
fn action(text: &str) -> String {
    if text == "NO_ACTION" {
        String::new()
    } else {
        text.replace('_', " ")
    }
}

/// The model of `["databases", db, "schemas", schema, "tables", name]` (empty: the types).
pub(crate) async fn model(connection: &MsConnection, path: &[String]) -> Result<DdlModel> {
    let types: Vec<String> = query(
        connection,
        "SELECT name FROM sys.types WHERE is_table_type = 0 ORDER BY name",
        &[],
    )
    .await?
    .rows
    .iter()
    .map(|row| text(row, 0))
    .collect();
    if path.is_empty() {
        return Ok(DdlModel {
            types,
            ..DdlModel::default()
        });
    }
    let [databases, db, schemas, schema, tables, name] = path else {
        return Err(DriverError::invalid("Only a table has a structure to edit"));
    };
    if databases != "databases" || schemas != "schemas" || tables != "tables" {
        return Err(DriverError::invalid("Only a table has a structure to edit"));
    }
    let db = database(db);
    let id = object(&db);
    let params = [schema.as_str(), name.as_str()];
    let columns = query(
        connection,
        &format!(
            "SELECT c.name, {TYPE}, c.is_nullable, OBJECT_DEFINITION(c.default_object_id), c.is_identity, \
             CAST(p.value AS nvarchar(4000)) FROM {db}.sys.columns c \
             JOIN {db}.sys.types t ON t.user_type_id = c.user_type_id \
             LEFT JOIN {db}.sys.extended_properties p ON p.major_id = c.object_id \
             AND p.minor_id = c.column_id AND p.name = 'MS_Description' \
             WHERE c.object_id = {id} ORDER BY c.column_id"
        ),
        &params,
    )
    .await?;
    if columns.rows.is_empty() {
        return Err(DriverError::invalid(format!(
            "There is no table {schema}.{name}"
        )));
    }
    let mut table = TableModel {
        schema: Some(schema.clone()),
        name: name.clone(),
        original: name.clone(),
        ..TableModel::default()
    };
    for row in &columns.rows {
        let column = text(row, 0);
        let default = text(row, 3);
        let comment = text(row, 5);
        table.columns.push(ColumnModel {
            original: column.clone(),
            name: column,
            type_name: text(row, 1),
            nullable: yes(row.get(2)),
            default: (!default.is_empty()).then(|| unwrapped(&default)),
            identity: yes(row.get(4)),
            comment: (!comment.is_empty()).then_some(comment),
        });
    }
    keys(connection, &db, &id, &params, &mut table).await?;
    indexes(connection, &db, &id, &params, &mut table).await?;
    let comment = query(
        connection,
        &format!(
            "SELECT CAST(value AS nvarchar(4000)) FROM {db}.sys.extended_properties \
             WHERE major_id = {id} AND minor_id = 0 AND name = 'MS_Description'"
        ),
        &params,
    )
    .await?;
    table.comment = comment
        .rows
        .first()
        .map(|row| text(row, 0))
        .filter(|text| !text.is_empty());
    Ok(DdlModel { table, types })
}

async fn keys(
    connection: &MsConnection,
    db: &str,
    id: &str,
    params: &[&str; 2],
    table: &mut TableModel,
) -> Result<()> {
    let keys = query(
        connection,
        &format!(
            "SELECT k.name, k.type, c.name FROM {db}.sys.key_constraints k \
             JOIN {db}.sys.index_columns x ON x.object_id = k.parent_object_id AND x.index_id = k.unique_index_id \
             JOIN {db}.sys.columns c ON c.object_id = x.object_id AND c.column_id = x.column_id \
             WHERE k.parent_object_id = {id} ORDER BY k.type, k.name, x.key_ordinal"
        ),
        params,
    )
    .await?;
    let mut uniques: BTreeMap<String, KeyModel> = BTreeMap::new();
    for row in &keys.rows {
        let (name, column) = (text(row, 0), text(row, 2));
        if text(row, 1).trim() == "PK" {
            table
                .primary_key
                .get_or_insert_with(|| KeyModel {
                    name,
                    columns: Vec::new(),
                })
                .columns
                .push(column);
        } else {
            uniques
                .entry(name.clone())
                .or_insert_with(|| KeyModel {
                    name,
                    columns: Vec::new(),
                })
                .columns
                .push(column);
        }
    }
    table.uniques = uniques.into_values().collect();
    let checks = query(
        connection,
        &format!("SELECT name, definition FROM {db}.sys.check_constraints WHERE parent_object_id = {id} ORDER BY name"),
        params,
    )
    .await?;
    table.checks = checks
        .rows
        .iter()
        .map(|row| CheckModel {
            name: text(row, 0),
            expression: unwrapped(&text(row, 1)),
        })
        .collect();
    let foreign = query(
        connection,
        &format!(
            "SELECT f.name, c.name, s.name, r.name, rc.name, f.delete_referential_action_desc, \
             f.update_referential_action_desc FROM {db}.sys.foreign_keys f \
             JOIN {db}.sys.foreign_key_columns k ON k.constraint_object_id = f.object_id \
             JOIN {db}.sys.columns c ON c.object_id = k.parent_object_id AND c.column_id = k.parent_column_id \
             JOIN {db}.sys.objects r ON r.object_id = f.referenced_object_id \
             JOIN {db}.sys.schemas s ON s.schema_id = r.schema_id \
             JOIN {db}.sys.columns rc ON rc.object_id = k.referenced_object_id AND rc.column_id = k.referenced_column_id \
             WHERE f.parent_object_id = {id} ORDER BY f.name, k.constraint_column_id"
        ),
        params,
    )
    .await?;
    let mut found: BTreeMap<String, ForeignKeyModel> = BTreeMap::new();
    for row in &foreign.rows {
        let name = text(row, 0);
        let key = found
            .entry(name.clone())
            .or_insert_with(|| ForeignKeyModel {
                name,
                referenced_schema: Some(text(row, 2)),
                referenced_table: text(row, 3),
                on_delete: action(&text(row, 5)),
                on_update: action(&text(row, 6)),
                ..ForeignKeyModel::default()
            });
        key.columns.push(text(row, 1));
        key.referenced_columns.push(text(row, 4));
    }
    table.foreign_keys = found.into_values().collect();
    Ok(())
}

async fn indexes(
    connection: &MsConnection,
    db: &str,
    id: &str,
    params: &[&str; 2],
    table: &mut TableModel,
) -> Result<()> {
    let rows = query(
        connection,
        &format!(
            "SELECT i.name, i.is_unique, i.type_desc, c.name, x.is_descending_key, i.filter_definition \
             FROM {db}.sys.indexes i JOIN {db}.sys.index_columns x ON x.object_id = i.object_id AND x.index_id = i.index_id \
             JOIN {db}.sys.columns c ON c.object_id = x.object_id AND c.column_id = x.column_id \
             WHERE i.object_id = {id} AND i.is_primary_key = 0 AND i.is_unique_constraint = 0 \
             AND i.type > 0 AND x.is_included_column = 0 ORDER BY i.name, x.key_ordinal"
        ),
        params,
    )
    .await?;
    let mut found: BTreeMap<String, IndexModel> = BTreeMap::new();
    for row in &rows.rows {
        let name = text(row, 0);
        let index = found.entry(name.clone()).or_insert_with(|| IndexModel {
            name,
            unique: yes(row.get(1)),
            method: if text(row, 2) == "CLUSTERED" {
                "clustered".into()
            } else {
                String::new()
            },
            condition: unwrapped(&text(row, 5)),
            ..IndexModel::default()
        });
        let column = text(row, 3);
        index.columns.push(if yes(row.get(4)) {
            format!("{column} DESC")
        } else {
            column
        });
    }
    table.indexes = found.into_values().collect();
    Ok(())
}
