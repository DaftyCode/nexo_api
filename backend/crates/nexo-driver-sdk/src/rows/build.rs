//! The statements of the changes, as the dialect writes them.
use super::{Cell, RowChange, RowsWriteParams};
use crate::{
    DriverError, Result, Value,
    protocol::{Dialect, ParameterStyle},
};

/// A statement to run: its text with placeholders, its values, and whether it must change
/// exactly one row.
#[derive(Debug, Clone, PartialEq)]
pub struct Built {
    pub sql: String,
    pub params: Vec<Value>,
    pub one_row: bool,
}

/// Writes a statement, numbering its placeholders as the dialect does.
struct Writer<'a> {
    dialect: &'a Dialect,
    sql: String,
    params: Vec<Value>,
}
impl Writer<'_> {
    fn name(&self, name: &str) -> String {
        let (open, close) = (&self.dialect.quote_open, &self.dialect.quote_close);
        format!(
            "{open}{}{close}",
            name.replace(close.as_str(), &close.repeat(2))
        )
    }
    fn bind(&mut self, value: &Value) -> String {
        self.params.push(value.clone());
        match self.dialect.parameters {
            ParameterStyle::Numbered => format!("${}", self.params.len()),
            ParameterStyle::Question => "?".into(),
            ParameterStyle::Named => format!("@P{}", self.params.len()),
        }
    }
    /// `column = ?`, or `column IS NULL`, for each cell.
    fn conditions(&mut self, cells: &[Cell]) -> Vec<String> {
        cells
            .iter()
            .map(|cell| match &cell.value {
                Value::Null => format!("{} IS NULL", self.name(&cell.column)),
                value => format!("{} = {}", self.name(&cell.column), self.bind(value)),
            })
            .collect()
    }
    /// The value of a cell: a placeholder or `DEFAULT`.
    fn value(&mut self, cell: &Cell) -> String {
        if cell.default {
            "DEFAULT".into()
        } else {
            self.bind(&cell.value)
        }
    }
    fn done(self, one_row: bool) -> Built {
        Built {
            sql: self.sql,
            params: self.params,
            one_row,
        }
    }
}

fn invalid(message: &str) -> DriverError {
    DriverError::invalid(message)
}

/// The statements of every change, in order.
pub fn statements(dialect: &Dialect, params: &RowsWriteParams) -> Result<Vec<Built>> {
    if params.table.trim().is_empty() {
        return Err(invalid("Name the table of the rows"));
    }
    let start = |dialect| Writer {
        dialect,
        sql: String::new(),
        params: Vec::new(),
    };
    let table = {
        let writer = start(dialect);
        match &params.schema {
            Some(schema) if !schema.is_empty() => {
                format!("{}.{}", writer.name(schema), writer.name(&params.table))
            }
            _ => writer.name(&params.table),
        }
    };
    params
        .changes
        .iter()
        .map(|change| {
            let mut writer = start(dialect);
            match change {
                RowChange::Insert { values } if values.iter().all(|cell| cell.default) => {
                    // MySQL has no DEFAULT VALUES.
                    writer.sql = if dialect.name == "mysql" {
                        format!("INSERT INTO {table} () VALUES ()")
                    } else {
                        format!("INSERT INTO {table} DEFAULT VALUES")
                    };
                    Ok(writer.done(true))
                }
                RowChange::Insert { values } => {
                    // A column left to its default is left out: every engine fills it.
                    let given: Vec<&Cell> = values.iter().filter(|cell| !cell.default).collect();
                    let names: Vec<String> = given.iter().map(|c| writer.name(&c.column)).collect();
                    let bound: Vec<String> = given.iter().map(|c| writer.bind(&c.value)).collect();
                    writer.sql = format!(
                        "INSERT INTO {table} ({}) VALUES ({})",
                        names.join(", "),
                        bound.join(", ")
                    );
                    Ok(writer.done(true))
                }
                RowChange::Update {
                    key,
                    values,
                    original,
                } => {
                    if key.is_empty() || values.is_empty() {
                        return Err(invalid("A changed row needs its key and its new values"));
                    }
                    if dialect.name == "sqlite" && values.iter().any(|cell| cell.default) {
                        return Err(invalid("SQLite cannot set a column back to its default"));
                    }
                    let set: Vec<String> = values
                        .iter()
                        .map(|cell| {
                            format!("{} = {}", writer.name(&cell.column), writer.value(cell))
                        })
                        .collect();
                    let mut conditions = writer.conditions(key);
                    if params.optimistic {
                        let changed: Vec<Cell> = original
                            .iter()
                            .filter(|old| values.iter().any(|new| new.column == old.column))
                            .cloned()
                            .collect();
                        conditions.extend(writer.conditions(&changed));
                    }
                    writer.sql = format!(
                        "UPDATE {table} SET {} WHERE {}",
                        set.join(", "),
                        conditions.join(" AND ")
                    );
                    Ok(writer.done(true))
                }
                RowChange::Delete { key, original } => {
                    if key.is_empty() {
                        return Err(invalid("A deleted row needs its key"));
                    }
                    let mut conditions = writer.conditions(key);
                    if params.optimistic {
                        conditions.extend(writer.conditions(original));
                    }
                    writer.sql = format!("DELETE FROM {table} WHERE {}", conditions.join(" AND "));
                    Ok(writer.done(true))
                }
            }
        })
        .collect()
}
