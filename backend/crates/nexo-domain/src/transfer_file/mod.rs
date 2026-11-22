//! The files of saved transfers (DB-40): rows written as CSV, JSON or JSON Lines page after
//! page, read back for an import, and the `{date}` of a file name filled with the time it
//! runs. Values of the drivers (`{"$t", "v"}`) are written as their text, plain JSON as it is.
mod csv;
#[cfg(test)]
mod tests;

pub use csv::{csv_line, read_csv};

use crate::{Error, Result};
use serde_json::{Map, Value};

/// How a transfer's file is written.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FileFormat {
    Csv,
    Json,
    JsonLines,
}

impl FileFormat {
    pub fn parse(text: &str) -> Result<Self> {
        match text {
            "csv" => Ok(Self::Csv),
            "json" => Ok(Self::Json),
            "jsonl" => Ok(Self::JsonLines),
            _ => Err(Error::Validation(
                "A file of a task is CSV, JSON or JSON Lines".into(),
            )),
        }
    }
}

/// A cell as text: `None` for a null; a typed value is its text, an array or object its JSON.
pub fn cell_text(value: &Value) -> Option<String> {
    match value {
        Value::Null => None,
        Value::String(text) => Some(text.clone()),
        Value::Object(fields) if fields.contains_key("$t") => match &fields["v"] {
            Value::String(text) => Some(text.clone()),
            _ => Some(json_cell(value).to_string()),
        },
        other => Some(other.to_string()),
    }
}

/// A cell as JSON: a typed value becomes its text (an array, its items), the rest stays.
pub fn json_cell(value: &Value) -> Value {
    match value {
        Value::Object(fields) if fields.contains_key("$t") => match &fields["v"] {
            Value::Array(items) => Value::Array(items.iter().map(json_cell).collect()),
            other => other.clone(),
        },
        other => other.clone(),
    }
}

/// Writes rows into a file page after page: the header or the opening first, the closing last.
#[derive(Debug, Clone)]
pub struct FileWriter {
    format: FileFormat,
    separator: char,
    header: bool,
    columns: Vec<String>,
    written: u64,
}

impl FileWriter {
    pub fn new(format: FileFormat, separator: char, header: bool, columns: Vec<String>) -> Self {
        Self {
            format,
            separator,
            header,
            columns,
            written: 0,
        }
    }
    /// What opens the file: the CSV header, or `[` of a JSON array.
    pub fn start(&self) -> String {
        match self.format {
            FileFormat::Csv if self.header => {
                let names: Vec<Option<String>> =
                    self.columns.iter().map(|name| Some(name.clone())).collect();
                csv_line(&names, self.separator)
            }
            FileFormat::Json => "[".into(),
            _ => String::new(),
        }
    }
    /// A page of rows, each one with a value per column.
    pub fn rows(&mut self, rows: &[Value]) -> String {
        let mut text = String::new();
        for row in rows {
            let cells = row.as_array().map(Vec::as_slice).unwrap_or_default();
            match self.format {
                FileFormat::Csv => {
                    let cells: Vec<Option<String>> = cells.iter().map(cell_text).collect();
                    text.push_str(&csv_line(&cells, self.separator));
                }
                FileFormat::Json | FileFormat::JsonLines => {
                    let object: Map<String, Value> = self
                        .columns
                        .iter()
                        .zip(cells)
                        .map(|(name, value)| (name.clone(), json_cell(value)))
                        .collect();
                    let line = Value::Object(object).to_string();
                    if self.format == FileFormat::Json {
                        text.push_str(if self.written == 0 { "\n  " } else { ",\n  " });
                        text.push_str(&line);
                    } else {
                        text.push_str(&line);
                        text.push('\n');
                    }
                }
            }
            self.written += 1;
        }
        text
    }
    /// What closes the file: `]` of a JSON array.
    pub fn finish(&self) -> String {
        match self.format {
            FileFormat::Json if self.written == 0 => "]\n".into(),
            FileFormat::Json => "\n]\n".into(),
            _ => String::new(),
        }
    }
    pub fn written(&self) -> u64 {
        self.written
    }
}

/// Documents written as JSON or JSON Lines, as they are (MongoDB's Extended JSON).
pub fn document_lines(documents: &[Value], format: FileFormat, first: bool) -> String {
    let mut text = String::new();
    for (at, document) in documents.iter().enumerate() {
        if format == FileFormat::Json {
            text.push_str(if first && at == 0 { "\n  " } else { ",\n  " });
            text.push_str(&document.to_string());
        } else {
            text.push_str(&document.to_string());
            text.push('\n');
        }
    }
    text
}

/// The objects of a JSON array or of JSON Lines.
pub fn read_objects(text: &str, format: FileFormat) -> Result<Vec<Map<String, Value>>> {
    let invalid = |what: String| Error::Validation(format!("The file is not valid {what}"));
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    let values: Vec<Value> = match format {
        FileFormat::Json => match serde_json::from_str(text) {
            Ok(Value::Array(items)) => items,
            Ok(_) => return Err(invalid("JSON: it is not an array of objects".into())),
            Err(error) => return Err(invalid(format!("JSON: {error}"))),
        },
        FileFormat::JsonLines => text
            .lines()
            .enumerate()
            .filter(|(_, line)| !line.trim().is_empty())
            .map(|(at, line)| {
                serde_json::from_str(line)
                    .map_err(|error| invalid(format!("JSON Lines: line {}: {error}", at + 1)))
            })
            .collect::<Result<_>>()?,
        FileFormat::Csv => return Err(invalid("JSON: it is CSV".into())),
    };
    values
        .into_iter()
        .enumerate()
        .map(|(at, value)| match value {
            Value::Object(object) => Ok(object),
            _ => Err(invalid(format!("JSON: item {} is not an object", at + 1))),
        })
        .collect()
}

/// The columns and rows of a file for a table: a CSV with its header, or JSON objects whose
/// keys, in the order they first appear, are the columns.
pub fn read_rows(
    text: &str,
    format: FileFormat,
    separator: char,
    empty_as_null: bool,
) -> Result<(Vec<String>, Vec<Value>)> {
    if format == FileFormat::Csv {
        let mut records = read_csv(text, separator)?.into_iter();
        let columns = records
            .next()
            .ok_or_else(|| Error::Validation("The file has no header".into()))?;
        let rows = records
            .map(|record| {
                Value::Array(
                    columns
                        .iter()
                        .enumerate()
                        .map(|(at, _)| match record.get(at) {
                            Some(cell) if !(empty_as_null && cell.is_empty()) => {
                                Value::String(cell.clone())
                            }
                            _ => Value::Null,
                        })
                        .collect(),
                )
            })
            .collect();
        return Ok((columns, rows));
    }
    let objects = read_objects(text, format)?;
    let mut columns: Vec<String> = Vec::new();
    for object in &objects {
        for key in object.keys() {
            if !columns.contains(key) {
                columns.push(key.clone());
            }
        }
    }
    let rows = objects
        .iter()
        .map(|object| {
            Value::Array(
                columns
                    .iter()
                    .map(|name| object.get(name).cloned().unwrap_or(Value::Null))
                    .collect(),
            )
        })
        .collect();
    Ok((columns, rows))
}

/// A file name with `{date}` as the time it runs (`2026-11-22_103000`, UTC).
pub fn dated(path: &str, unix_ms: i64) -> String {
    if !path.contains("{date}") {
        return path.to_owned();
    }
    let seconds = unix_ms.div_euclid(1000);
    let (days, rest) = (seconds.div_euclid(86_400), seconds.rem_euclid(86_400));
    // Civil from days (Howard Hinnant's algorithm).
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    let stamp = format!(
        "{year:04}-{month:02}-{day:02}_{:02}{:02}{:02}",
        rest / 3600,
        rest % 3600 / 60,
        rest % 60
    );
    path.replace("{date}", &stamp)
}
