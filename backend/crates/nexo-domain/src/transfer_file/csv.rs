//! CSV as RFC 4180 writes it: a cell with the separator, a quote or a line break goes in
//! quotes, its quotes doubled; a null is an empty cell.
use crate::{Error, Result};

/// A line of cells, ending with CRLF.
pub fn csv_line(cells: &[Option<String>], separator: char) -> String {
    let mut line = String::new();
    for (at, cell) in cells.iter().enumerate() {
        if at > 0 {
            line.push(separator);
        }
        let text = cell.as_deref().unwrap_or_default();
        if text.contains(separator) || text.contains(['"', '\n', '\r']) {
            line.push('"');
            line.push_str(&text.replace('"', "\"\""));
            line.push('"');
        } else {
            line.push_str(text);
        }
    }
    line.push_str("\r\n");
    line
}

/// The records of a CSV text, quoted cells and their line breaks included.
pub fn read_csv(text: &str, separator: char) -> Result<Vec<Vec<String>>> {
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    let mut records = Vec::new();
    let mut record = Vec::new();
    let mut cell = String::new();
    let mut quoted = false;
    let mut chars = text.chars().peekable();
    while let Some(char) = chars.next() {
        if quoted {
            if char == '"' {
                if chars.peek() == Some(&'"') {
                    chars.next();
                    cell.push('"');
                } else {
                    quoted = false;
                }
            } else {
                cell.push(char);
            }
            continue;
        }
        match char {
            '"' if cell.is_empty() => quoted = true,
            '\r' if chars.peek() == Some(&'\n') => {}
            '\n' | '\r' => {
                record.push(std::mem::take(&mut cell));
                records.push(std::mem::take(&mut record));
            }
            char if char == separator => record.push(std::mem::take(&mut cell)),
            char => cell.push(char),
        }
    }
    if quoted {
        return Err(Error::Validation(
            "The file is not valid CSV: a quote is never closed".into(),
        ));
    }
    if !cell.is_empty() || !record.is_empty() {
        record.push(cell);
        records.push(record);
    }
    Ok(records)
}
