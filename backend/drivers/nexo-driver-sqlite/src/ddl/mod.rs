//! The structure editor of SQLite: the model of a table read from its pragmas (and its
//! `CHECK` constraints from its SQL, so a rebuild keeps them), the types SQLite takes, and the
//! DDL of each change ([`writer`]).
#[cfg(test)]
mod tests;
pub(crate) mod writer;

use crate::{
    catalog::{query, text},
    connection::SqliteConnection,
};
use nexo_driver_sdk::{
    DriverError, Result, Value,
    ddl::{CheckModel, ColumnModel, DdlModel, ForeignKeyModel, IndexModel, KeyModel, TableModel},
};
use std::collections::BTreeMap;

/// What SQLite reads a type as, and the names other tools write.
pub(crate) const TYPES: [&str; 12] = [
    "INTEGER",
    "REAL",
    "TEXT",
    "BLOB",
    "NUMERIC",
    "BOOLEAN",
    "DATE",
    "DATETIME",
    "VARCHAR(255)",
    "DECIMAL(10,2)",
    "JSON",
    "UUID",
];

fn number(value: Option<&Value>) -> i64 {
    match value {
        Some(Value::Integer(number)) => *number,
        Some(Value::Text(text)) => text.parse().unwrap_or(0),
        _ => 0,
    }
}

/// The `CHECK` constraints of a table's SQL: `CONSTRAINT name CHECK (…)` or `CHECK (…)`, at
/// any depth of its declaration, outside strings and quoted names.
pub(crate) fn checks_of(sql: &str) -> Vec<CheckModel> {
    let chars: Vec<char> = sql.chars().collect();
    let upper: Vec<char> = sql.to_uppercase().chars().collect();
    let mut found = Vec::new();
    let mut at = 0;
    let mut quote: Option<char> = None;
    while at < chars.len() {
        let character = chars[at];
        if let Some(open) = quote {
            if character == open {
                quote = None;
            }
            at += 1;
            continue;
        }
        if matches!(character, '\'' | '"' | '`' | '[') {
            quote = Some(if character == '[' { ']' } else { character });
            at += 1;
            continue;
        }
        let word_start = at == 0 || !chars[at - 1].is_alphanumeric() && chars[at - 1] != '_';
        if word_start && upper[at..].starts_with(&['C', 'H', 'E', 'C', 'K']) {
            let mut open = at + 5;
            while open < chars.len() && chars[open].is_whitespace() {
                open += 1;
            }
            if chars.get(open) == Some(&'(') {
                let (mut depth, mut close) = (0, open);
                while close < chars.len() {
                    match chars[close] {
                        '(' => depth += 1,
                        ')' => {
                            depth -= 1;
                            if depth == 0 {
                                break;
                            }
                        }
                        _ => {}
                    }
                    close += 1;
                }
                let expression: String = chars[open + 1..close.min(chars.len())].iter().collect();
                // The name of `CONSTRAINT name CHECK`.
                let before: String = chars[..at].iter().collect();
                let words: Vec<&str> = before.split_whitespace().collect();
                let name = match words.as_slice() {
                    [.., constraint, name] if constraint.eq_ignore_ascii_case("CONSTRAINT") => name
                        .trim_matches(|c| matches!(c, '"' | '`' | '[' | ']'))
                        .to_owned(),
                    _ => String::new(),
                };
                found.push(CheckModel {
                    name,
                    expression: expression.trim().to_owned(),
                });
                at = close + 1;
                continue;
            }
        }
        at += 1;
    }
    found
}

/// The model of the table at `["tables", name]` (empty: the types alone).
pub(crate) async fn model(connection: &SqliteConnection, path: &[String]) -> Result<DdlModel> {
    let types = TYPES.map(String::from).to_vec();
    if path.is_empty() {
        return Ok(DdlModel {
            types,
            ..DdlModel::default()
        });
    }
    let [tables, name] = path else {
        return Err(DriverError::invalid("Only a table has a structure to edit"));
    };
    if tables != "tables" {
        return Err(DriverError::invalid("Only a table has a structure to edit"));
    }
    let source = query(
        connection,
        "SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = ?1",
        &[name],
    )
    .await?;
    let Some(sql) = source.rows.first().map(|row| text(row, 0)) else {
        return Err(DriverError::invalid(format!("There is no table {name}")));
    };
    let mut table = TableModel {
        name: name.clone(),
        original: name.clone(),
        ..TableModel::default()
    };
    let columns = query(
        connection,
        "SELECT name, type, \"notnull\", dflt_value, pk FROM pragma_table_xinfo(?1) WHERE hidden = 0 ORDER BY cid",
        &[name],
    )
    .await?;
    let autoincrement = sql.to_uppercase().contains("AUTOINCREMENT");
    let mut key: Vec<(i64, String)> = Vec::new();
    for row in &columns.rows {
        let column = text(row, 0);
        let pk = number(row.get(4));
        if pk > 0 {
            key.push((pk, column.clone()));
        }
        let default = text(row, 3);
        table.columns.push(ColumnModel {
            original: column.clone(),
            name: column,
            type_name: text(row, 1),
            nullable: number(row.get(2)) == 0,
            default: (!default.is_empty()).then_some(default),
            identity: false,
            comment: None,
        });
    }
    key.sort();
    let single_integer = key.len() == 1
        && table.columns.iter().any(|column| {
            column.name == key[0].1 && column.type_name.eq_ignore_ascii_case("INTEGER")
        });
    if single_integer
        && autoincrement
        && let Some(column) = table
            .columns
            .iter_mut()
            .find(|column| column.name == key[0].1)
    {
        column.identity = true;
    }
    if !key.is_empty() {
        table.primary_key = Some(KeyModel {
            name: String::new(),
            columns: key.into_iter().map(|(_, name)| name).collect(),
        });
    }
    table.checks = checks_of(&sql);
    let foreign = query(
        connection,
        "SELECT id, \"table\", \"from\", \"to\", on_update, on_delete FROM pragma_foreign_key_list(?1) ORDER BY id, seq",
        &[name],
    )
    .await?;
    let mut keys: BTreeMap<i64, ForeignKeyModel> = BTreeMap::new();
    for row in &foreign.rows {
        let key = keys
            .entry(number(row.first()))
            .or_insert_with(|| ForeignKeyModel {
                referenced_table: text(row, 1),
                on_update: Some(text(row, 4))
                    .filter(|rule| rule != "NO ACTION")
                    .unwrap_or_default(),
                on_delete: Some(text(row, 5))
                    .filter(|rule| rule != "NO ACTION")
                    .unwrap_or_default(),
                ..ForeignKeyModel::default()
            });
        key.columns.push(text(row, 2));
        key.referenced_columns.push(text(row, 3));
    }
    table.foreign_keys = keys.into_values().collect();
    let lists = query(
        connection,
        "SELECT l.name, l.\"unique\", l.origin, l.partial, s.sql FROM pragma_index_list(?1) l \
         LEFT JOIN sqlite_schema s ON s.type = 'index' AND s.name = l.name ORDER BY l.name",
        &[name],
    )
    .await?;
    for row in &lists.rows {
        let index = text(row, 0);
        let parts = query(
            connection,
            "SELECT name, \"desc\" FROM pragma_index_xinfo(?1) WHERE key = 1 ORDER BY seqno",
            &[&index],
        )
        .await?;
        let columns: Vec<String> = parts
            .rows
            .iter()
            .map(|part| {
                let column = text(part, 0);
                if number(part.get(1)) == 1 {
                    format!("{column} DESC")
                } else {
                    column
                }
            })
            .collect();
        match text(row, 2).as_str() {
            "u" => table.uniques.push(KeyModel {
                name: String::new(),
                columns,
            }),
            "c" => {
                let source = text(row, 4);
                let condition = source
                    .to_uppercase()
                    .rfind(" WHERE ")
                    .map(|at| source[at + 7..].trim().to_owned())
                    .unwrap_or_default();
                table.indexes.push(IndexModel {
                    name: index,
                    columns,
                    unique: number(row.get(1)) == 1,
                    method: String::new(),
                    condition,
                });
            }
            _ => {}
        }
    }
    Ok(DdlModel { table, types })
}
