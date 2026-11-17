//! The statements of an import, as the dialect writes them, with placeholders.
use super::ImportParams;
use crate::{
    DriverError, Result,
    protocol::{Dialect, ParameterStyle},
};

/// Bound values a statement takes, at most: SQL Server's limit is 2 100.
pub const MAX_PARAMS: usize = 2_000;

fn name(dialect: &Dialect, name: &str) -> String {
    let (open, close) = (&dialect.quote_open, &dialect.quote_close);
    format!(
        "{open}{}{close}",
        name.replace(close.as_str(), &close.repeat(2))
    )
}

fn table(dialect: &Dialect, params: &ImportParams) -> String {
    match params.schema.as_deref().filter(|schema| !schema.is_empty()) {
        Some(schema) => format!("{}.{}", name(dialect, schema), name(dialect, &params.table)),
        None => name(dialect, &params.table),
    }
}

/// The placeholder of the `at`-th value of a statement, from 1.
fn placeholder(dialect: &Dialect, at: usize) -> String {
    match dialect.parameters {
        ParameterStyle::Numbered => format!("${at}"),
        ParameterStyle::Question => "?".into(),
        ParameterStyle::Named => format!("@P{at}"),
    }
}

/// Refuses a batch without columns, or with a row that has not one value per column.
pub(super) fn check(params: &ImportParams) -> Result<()> {
    if params.columns.is_empty() {
        return Err(DriverError::invalid("An import needs at least one column"));
    }
    if let Some(row) = params
        .rows
        .iter()
        .position(|row| row.len() != params.columns.len())
    {
        return Err(DriverError::invalid(format!(
            "Row {} has {} values for {} columns",
            params.first + row as u64,
            params.rows[row].len(),
            params.columns.len()
        )));
    }
    Ok(())
}

/// `INSERT INTO t (a, b) VALUES (…), (…)` of `rows` rows.
pub fn insert(dialect: &Dialect, params: &ImportParams, rows: usize) -> Result<String> {
    check(params)?;
    let width = params.columns.len();
    let columns: Vec<String> = params.columns.iter().map(|c| name(dialect, c)).collect();
    let values: Vec<String> = (0..rows)
        .map(|row| {
            let cells: Vec<String> = (1..=width)
                .map(|at| placeholder(dialect, row * width + at))
                .collect();
            format!("({})", cells.join(", "))
        })
        .collect();
    Ok(format!(
        "INSERT INTO {} ({}) VALUES {}",
        table(dialect, params),
        columns.join(", "),
        values.join(", ")
    ))
}

/// The statement that inserts one row or updates the one with its key, in the dialect.
pub fn upsert(dialect: &Dialect, params: &ImportParams) -> Result<String> {
    check(params)?;
    if params.key.is_empty() {
        return Err(DriverError::invalid(
            "Inserting or updating needs the columns that name a row",
        ));
    }
    if let Some(missing) = params.key.iter().find(|key| !params.columns.contains(key)) {
        return Err(DriverError::invalid(format!(
            "The key column {missing} is not imported"
        )));
    }
    let quoted = |column: &String| name(dialect, column);
    let others: Vec<&String> = params
        .columns
        .iter()
        .filter(|column| !params.key.contains(column))
        .collect();
    let target = table(dialect, params);
    if dialect.name == "tsql" {
        let source: Vec<String> = params
            .columns
            .iter()
            .enumerate()
            .map(|(at, column)| format!("{} AS {}", placeholder(dialect, at + 1), quoted(column)))
            .collect();
        let on: Vec<String> = params
            .key
            .iter()
            .map(|key| format!("t.{0} = s.{0}", quoted(key)))
            .collect();
        let set: Vec<String> = others
            .iter()
            .map(|c| format!("t.{0} = s.{0}", quoted(c)))
            .collect();
        let columns: Vec<String> = params.columns.iter().map(quoted).collect();
        let values: Vec<String> = params
            .columns
            .iter()
            .map(|c| format!("s.{}", quoted(c)))
            .collect();
        let matched = if set.is_empty() {
            String::new()
        } else {
            format!(" WHEN MATCHED THEN UPDATE SET {}", set.join(", "))
        };
        return Ok(format!(
            "MERGE INTO {target} AS t USING (SELECT {}) AS s ON {}{matched} WHEN NOT MATCHED THEN INSERT ({}) VALUES ({});",
            source.join(", "),
            on.join(" AND "),
            columns.join(", "),
            values.join(", ")
        ));
    }
    let insert = insert(dialect, params, 1)?;
    Ok(match dialect.name.as_str() {
        "mysql" | "mariadb" => {
            let set: Vec<String> = others
                .iter()
                .map(|c| format!("{0} = VALUES({0})", quoted(c)))
                .collect();
            // Without other columns, a key that exists is left as it is.
            let set = if set.is_empty() {
                let key = quoted(&params.key[0]);
                vec![format!("{key} = {key}")]
            } else {
                set
            };
            format!("{insert} ON DUPLICATE KEY UPDATE {}", set.join(", "))
        }
        _ => {
            let key: Vec<String> = params.key.iter().map(quoted).collect();
            let action = if others.is_empty() {
                "DO NOTHING".to_owned()
            } else {
                let set: Vec<String> = others
                    .iter()
                    .map(|c| format!("{0} = EXCLUDED.{0}", quoted(c)))
                    .collect();
                format!("DO UPDATE SET {}", set.join(", "))
            };
            format!("{insert} ON CONFLICT ({}) {action}", key.join(", "))
        }
    })
}
