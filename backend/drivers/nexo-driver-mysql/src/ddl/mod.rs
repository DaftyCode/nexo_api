//! The structure editor of MySQL and MariaDB: the model of a table read from
//! `information_schema`, the types a column may take, and the DDL of each change ([`writer`]).
#[cfg(test)]
mod tests;
pub(crate) mod writer;

use crate::{
    catalog::{query, text},
    connection::MyConnection,
};
use nexo_driver_sdk::{
    DriverError, Result, Value,
    ddl::{CheckModel, ColumnModel, DdlModel, ForeignKeyModel, IndexModel, KeyModel, TableModel},
};
use std::collections::BTreeMap;

/// The types of MySQL and MariaDB, as a column is declared with them.
pub(crate) const TYPES: [&str; 33] = [
    "tinyint",
    "smallint",
    "mediumint",
    "int",
    "bigint",
    "decimal(10,2)",
    "float",
    "double",
    "bit(1)",
    "boolean",
    "date",
    "datetime",
    "datetime(6)",
    "timestamp",
    "time",
    "year",
    "char(1)",
    "varchar(255)",
    "tinytext",
    "text",
    "mediumtext",
    "longtext",
    "binary(16)",
    "varbinary(255)",
    "blob",
    "mediumblob",
    "longblob",
    "json",
    "enum('a','b')",
    "set('a','b')",
    "geometry",
    "point",
    "uuid",
];

fn yes(value: Option<&Value>) -> bool {
    matches!(value, Some(Value::Integer(1) | Value::Bool(true)))
        || matches!(value, Some(Value::Text(text)) if text == "1" || text.eq_ignore_ascii_case("yes"))
}

/// The default as the column is declared again with it. MariaDB writes it as SQL already
/// (`'new'`, `NULL`); MySQL writes a text without its quotes, and expressions as they are.
pub(crate) fn default_of(
    raw: Option<String>,
    column_type: &str,
    extra: &str,
    mariadb: bool,
) -> Option<String> {
    let raw = raw?;
    if mariadb {
        return (raw != "NULL").then_some(raw);
    }
    let numeric = ["int", "decimal", "float", "double", "bit", "year", "bool"]
        .iter()
        .any(|kind| column_type.contains(kind));
    let expression =
        extra.contains("DEFAULT_GENERATED") || raw.eq_ignore_ascii_case("CURRENT_TIMESTAMP");
    if numeric || expression {
        Some(
            if expression && !raw.starts_with('(') && raw.contains('(') {
                format!("({raw})")
            } else {
                raw
            },
        )
    } else {
        Some(format!("'{}'", raw.replace('\'', "''")))
    }
}

/// The model of the table at `["databases", db, "tables", name]` (empty: the types alone).
pub(crate) async fn model(connection: &MyConnection, path: &[String]) -> Result<DdlModel> {
    let types = TYPES.map(String::from).to_vec();
    if path.is_empty() {
        return Ok(DdlModel {
            types,
            ..DdlModel::default()
        });
    }
    let [databases, db, tables, name] = path else {
        return Err(DriverError::invalid("Only a table has a structure to edit"));
    };
    if databases != "databases" || tables != "tables" {
        return Err(DriverError::invalid("Only a table has a structure to edit"));
    }
    let mariadb = connection.server.mariadb;
    let params = [db.as_str(), name.as_str()];
    let columns = query(
        connection,
        "SELECT column_name, column_type, is_nullable = 'YES', column_default, extra, column_comment \
         FROM information_schema.columns WHERE table_schema = ? AND table_name = ? ORDER BY ordinal_position",
        &params,
    )
    .await?;
    if columns.rows.is_empty() {
        return Err(DriverError::invalid(format!(
            "There is no table {db}.{name}"
        )));
    }
    let mut table = TableModel {
        schema: Some(db.clone()),
        name: name.clone(),
        original: name.clone(),
        ..TableModel::default()
    };
    for row in &columns.rows {
        let column = text(row, 0);
        let column_type = text(row, 1);
        let extra = text(row, 4);
        let raw = match row.get(3) {
            Some(Value::Null) | None => None,
            _ => Some(text(row, 3)),
        };
        let comment = text(row, 5);
        table.columns.push(ColumnModel {
            original: column.clone(),
            name: column,
            default: default_of(raw, &column_type, &extra, mariadb),
            type_name: column_type,
            nullable: yes(row.get(2)),
            identity: extra.contains("auto_increment"),
            comment: (!comment.is_empty()).then_some(comment),
        });
    }
    let keys = query(
        connection,
        "SELECT k.constraint_name, t.constraint_type, k.column_name, k.referenced_table_schema, \
         k.referenced_table_name, k.referenced_column_name, r.delete_rule, r.update_rule \
         FROM information_schema.key_column_usage k JOIN information_schema.table_constraints t \
         ON t.constraint_schema = k.constraint_schema AND t.table_name = k.table_name \
         AND t.constraint_name = k.constraint_name LEFT JOIN information_schema.referential_constraints r \
         ON r.constraint_schema = k.constraint_schema AND r.constraint_name = k.constraint_name \
         WHERE k.table_schema = ? AND k.table_name = ? ORDER BY t.constraint_type, k.constraint_name, k.ordinal_position",
        &params,
    )
    .await?;
    let mut uniques: BTreeMap<String, KeyModel> = BTreeMap::new();
    let mut foreign: BTreeMap<String, ForeignKeyModel> = BTreeMap::new();
    for row in &keys.rows {
        let constraint = text(row, 0);
        let column = text(row, 2);
        match text(row, 1).as_str() {
            "PRIMARY KEY" => table
                .primary_key
                .get_or_insert_with(|| KeyModel {
                    name: String::new(),
                    columns: Vec::new(),
                })
                .columns
                .push(column),
            "UNIQUE" => uniques
                .entry(constraint.clone())
                .or_insert_with(|| KeyModel {
                    name: constraint,
                    columns: Vec::new(),
                })
                .columns
                .push(column),
            "FOREIGN KEY" => {
                let key = foreign
                    .entry(constraint.clone())
                    .or_insert_with(|| ForeignKeyModel {
                        name: constraint,
                        referenced_schema: Some(text(row, 3)).filter(|schema| schema != db),
                        referenced_table: text(row, 4),
                        on_delete: rule(&text(row, 6)),
                        on_update: rule(&text(row, 7)),
                        ..ForeignKeyModel::default()
                    });
                key.columns.push(column);
                key.referenced_columns.push(text(row, 5));
            }
            _ => {}
        }
    }
    table.uniques = uniques.into_values().collect();
    table.foreign_keys = foreign.into_values().collect();
    let checks = query(
        connection,
        "SELECT c.constraint_name, c.check_clause FROM information_schema.check_constraints c \
         JOIN information_schema.table_constraints t ON t.constraint_schema = c.constraint_schema \
         AND t.constraint_name = c.constraint_name WHERE t.table_schema = ? AND t.table_name = ? \
         AND t.constraint_type = 'CHECK' ORDER BY 1",
        &params,
    )
    .await
    .map(|rows| rows.rows)
    .unwrap_or_default();
    table.checks = checks
        .iter()
        .map(|row| CheckModel {
            name: text(row, 0),
            expression: text(row, 1),
        })
        .collect();
    indexes(connection, &params, &mut table).await?;
    let about = query(
        connection,
        "SELECT table_comment, engine, table_collation FROM information_schema.tables \
         WHERE table_schema = ? AND table_name = ?",
        &params,
    )
    .await?;
    if let Some(row) = about.rows.first() {
        let comment = text(row, 0);
        table.comment = (!comment.is_empty()).then_some(comment);
        table.options.insert("engine".into(), text(row, 1));
        table.options.insert("collation".into(), text(row, 2));
    }
    Ok(DdlModel { table, types })
}

/// The action of a foreign key, empty for the default (`NO ACTION`).
fn rule(text: &str) -> String {
    if text == "NO ACTION" {
        String::new()
    } else {
        text.to_owned()
    }
}

/// The indexes no constraint made: their columns in order, unique or not, and their kind.
async fn indexes(
    connection: &MyConnection,
    params: &[&str; 2],
    table: &mut TableModel,
) -> Result<()> {
    // MariaDB has no indexes of expressions.
    let expression = if connection.server.mariadb {
        "NULL"
    } else {
        "expression"
    };
    let sql = format!(
        "SELECT index_name, non_unique = 0, index_type, column_name, collation, {expression} \
         FROM information_schema.statistics WHERE table_schema = ? AND table_name = ? \
         ORDER BY index_name, seq_in_index"
    );
    let rows = query(connection, &sql, params).await?;
    let taken: Vec<&str> = table
        .uniques
        .iter()
        .map(|key| key.name.as_str())
        .chain(table.foreign_keys.iter().map(|key| key.name.as_str()))
        .chain(["PRIMARY"])
        .collect();
    let mut found: BTreeMap<String, IndexModel> = BTreeMap::new();
    for row in &rows.rows {
        let name = text(row, 0);
        if taken.contains(&name.as_str()) {
            continue;
        }
        let kind = text(row, 2).to_ascii_lowercase();
        let index = found.entry(name.clone()).or_insert_with(|| IndexModel {
            name,
            unique: yes(row.get(1)),
            method: if kind == "btree" { String::new() } else { kind },
            ..IndexModel::default()
        });
        let column = match text(row, 3) {
            column if column.is_empty() => format!("({})", text(row, 5)),
            column => column,
        };
        let descending = text(row, 4) == "D";
        index.columns.push(if descending {
            format!("{column} DESC")
        } else {
            column
        });
    }
    table.indexes = found.into_values().collect();
    Ok(())
}
