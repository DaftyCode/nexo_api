//! Excel and OpenDocument workbooks (DB-30): read with calamine, in pure Rust, into a table of
//! their own (DuckDB's Excel reader is an extension the driver does not load). A sheet, the
//! first one unless the connection names another, its first row the names of the columns
//! unless `header` says not; each column typed by what its cells hold.
use crate::{
    connection::failed,
    target::{DataFile, Readers},
};
use calamine::{Data, Reader, open_workbook_auto};
use duckdb::{Connection, types::Value as Duck};
use nexo_driver_sdk::{DriverError, Result};

/// Cells a workbook may give at most: it is read whole into memory.
const MAX_CELLS: usize = 20_000_000;

#[derive(Clone, Copy, PartialEq, Eq)]
enum Kind {
    Empty,
    Boolean,
    Integer,
    Double,
    Timestamp,
    Text,
}
impl Kind {
    fn of(cell: &Data) -> Kind {
        match cell {
            Data::Empty => Kind::Empty,
            Data::Bool(_) => Kind::Boolean,
            Data::Int(_) => Kind::Integer,
            Data::Float(number) if number.fract() == 0.0 && number.abs() < 9e15 => Kind::Integer,
            Data::Float(_) => Kind::Double,
            Data::DateTime(_) | Data::DateTimeIso(_) => Kind::Timestamp,
            _ => Kind::Text,
        }
    }
    /// What a column holds when it holds both.
    fn join(self, other: Kind) -> Kind {
        match (self, other) {
            (Kind::Empty, other) | (other, Kind::Empty) => other,
            (a, b) if a == b => a,
            (Kind::Integer, Kind::Double) | (Kind::Double, Kind::Integer) => Kind::Double,
            _ => Kind::Text,
        }
    }
    fn sql(self) -> &'static str {
        match self {
            Kind::Boolean => "BOOLEAN",
            Kind::Integer => "BIGINT",
            Kind::Double => "DOUBLE",
            Kind::Timestamp => "TIMESTAMP",
            Kind::Empty | Kind::Text => "VARCHAR",
        }
    }
}

fn value(cell: &Data, kind: Kind) -> Duck {
    match (cell, kind) {
        (Data::Empty, _) => Duck::Null,
        (Data::Bool(value), Kind::Boolean) => Duck::Boolean(*value),
        (Data::Int(value), Kind::Integer) => Duck::BigInt(*value),
        (Data::Float(value), Kind::Integer) => Duck::BigInt(*value as i64),
        (Data::Int(value), Kind::Double) => Duck::Double(*value as f64),
        (Data::Float(value), Kind::Double) => Duck::Double(*value),
        (Data::DateTime(date), Kind::Timestamp) => Duck::Text(timestamp(date.as_f64())),
        (Data::DateTimeIso(text), Kind::Timestamp) => Duck::Text(text.clone()),
        (other, _) => Duck::Text(other.to_string()),
    }
}

/// An Excel serial date (days since 1899-12-30, the time as their fraction) as ISO text.
fn timestamp(serial: f64) -> String {
    let seconds = (serial * 86_400.0).round() as i64;
    let (days, time) = (
        seconds.div_euclid(86_400) - 25_569,
        seconds.rem_euclid(86_400),
    );
    // Days since 1970-01-01 to a civil date (H. Hinnant).
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!(
        "{year:04}-{month:02}-{day:02} {:02}:{:02}:{:02}",
        time / 3_600,
        time / 60 % 60,
        time % 60
    )
}

/// Reads a sheet of a workbook into a table named after the file.
pub fn load(conn: &Connection, file: &DataFile, readers: &Readers) -> Result<()> {
    let path = file.path.display();
    let mut workbook = open_workbook_auto(&file.path)
        .map_err(|error| DriverError::invalid(format!("{path}: {error}")))?;
    let sheet = match &readers.sheet {
        Some(sheet) => sheet.clone(),
        None => workbook
            .sheet_names()
            .first()
            .cloned()
            .ok_or_else(|| DriverError::invalid(format!("{path} has no sheets")))?,
    };
    let range = workbook
        .worksheet_range(&sheet)
        .map_err(|error| DriverError::invalid(format!("{path}, sheet {sheet}: {error}")))?;
    let (height, width) = range.get_size();
    if height.saturating_mul(width) > MAX_CELLS {
        return Err(DriverError::invalid(format!(
            "{path} has too many cells to read"
        )));
    }
    let mut rows = range.rows();
    let header = readers.header != Some(false);
    let names: Vec<String> = if header {
        rows.next()
            .map(|row| {
                row.iter()
                    .enumerate()
                    .map(|(at, cell)| match cell.to_string().trim() {
                        "" => format!("column{}", at + 1),
                        name => name.to_owned(),
                    })
                    .collect()
            })
            .unwrap_or_default()
    } else {
        (1..=width).map(|at| format!("column{at}")).collect()
    };
    let body: Vec<&[Data]> = rows.collect();
    let kinds: Vec<Kind> = (0..names.len())
        .map(|column| {
            body.iter()
                .filter_map(|row| row.get(column))
                .fold(Kind::Empty, |kind, cell| kind.join(Kind::of(cell)))
        })
        .collect();
    let quoted = |name: &str| format!("\"{}\"", name.replace('"', "\"\""));
    let definition = names
        .iter()
        .zip(&kinds)
        .map(|(name, kind)| format!("{} {}", quoted(name), kind.sql()))
        .collect::<Vec<_>>()
        .join(", ");
    conn.execute_batch(&format!(
        "CREATE TABLE {} ({definition})",
        quoted(&file.table)
    ))
    .map_err(failed)?;
    let mut appender = conn.appender(&file.table).map_err(failed)?;
    for row in body {
        let cells: Vec<Duck> = (0..names.len())
            .map(|column| {
                row.get(column)
                    .map_or(Duck::Null, |cell| value(cell, kinds[column]))
            })
            .collect();
        appender
            .append_row(duckdb::appender_params_from_iter(cells))
            .map_err(failed)?;
    }
    appender.flush().map_err(failed)
}

#[cfg(test)]
mod tests {
    use super::timestamp;

    #[test]
    fn excel_dates_become_iso_timestamps() {
        assert_eq!(timestamp(45_658.5), "2025-01-01 12:00:00");
        assert_eq!(timestamp(25_569.0), "1970-01-01 00:00:00");
    }
}
