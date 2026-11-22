//! MySQL's values as the driver protocol writes them, by the type of their column: from the
//! text protocol (every value as text) or the binary one (statements with parameters). Large
//! values are cut at the limit of one value, saying how long they were.
#[cfg(test)]
mod tests;
mod types;

use mysql_async::{
    Column as MyColumn, Row, Value as MyValue,
    consts::{ColumnFlags, ColumnType},
};
use nexo_driver_sdk::{Column, Value, ValueKind, limits, value::Origin};
pub(crate) use types::{kind_of, type_name};

/// The columns of a result, with the table each one comes from and whether it is part of
/// the table's primary key, as the server says.
pub(crate) fn columns(columns: &[MyColumn]) -> Vec<Column> {
    columns
        .iter()
        .map(|column| {
            let mut described = Column::new(column.name_str(), type_name(column), kind_of(column));
            described.nullable = Some(!column.flags().contains(ColumnFlags::NOT_NULL_FLAG));
            let table = column.org_table_str();
            if !table.is_empty() {
                described.key = column.flags().contains(ColumnFlags::PRI_KEY_FLAG);
                described.origin = Some(Origin {
                    schema: Some(column.schema_str().into_owned()).filter(|s| !s.is_empty()),
                    table: table.into_owned(),
                    column: column.org_name_str().into_owned(),
                });
            }
            described
        })
        .collect()
}

/// The values of a row, by the types of its columns.
pub(crate) fn row(row: Row, columns: &[MyColumn]) -> Vec<Value> {
    row.unwrap()
        .into_iter()
        .zip(columns)
        .map(|(value, column)| self::value(value, column))
        .collect()
}

/// Text cut at the limit of one value.
fn text(kind: ValueKind, text: String) -> Value {
    if text.len() <= limits::VALUE_BYTES {
        return if kind == ValueKind::Text {
            Value::Text(text)
        } else {
            Value::typed(kind, text)
        };
    }
    let mut end = limits::VALUE_BYTES;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    Value::Typed {
        kind,
        text: text[..end].to_owned(),
        full_size: Some(text.len() as u64),
    }
}

/// Bytes cut at the limit of one value.
fn bytes(bytes: &[u8]) -> Value {
    if bytes.len() <= limits::VALUE_BYTES {
        return Value::bytes(bytes);
    }
    match Value::bytes(&bytes[..limits::VALUE_BYTES]) {
        Value::Typed { kind, text, .. } => Value::Typed {
            kind,
            text,
            full_size: Some(bytes.len() as u64),
        },
        other => other,
    }
}

/// A geometry as MySQL keeps it (its SRID, four bytes, then WKB) as EWKB, the SRID inside the
/// WKB as PostGIS sends it (DB-29); anything else as it came.
fn ewkb(raw: Vec<u8>) -> Vec<u8> {
    let (Some(srid), Some(&order), Some(kind)) = (raw.get(..4), raw.get(4), raw.get(5..9)) else {
        return raw;
    };
    let kind: [u8; 4] = [kind[0], kind[1], kind[2], kind[3]];
    let (kind, srid) = match order {
        1 => (
            (u32::from_le_bytes(kind) | 0x2000_0000).to_le_bytes(),
            [srid[0], srid[1], srid[2], srid[3]],
        ),
        0 => (
            (u32::from_be_bytes(kind) | 0x2000_0000).to_be_bytes(),
            u32::from_le_bytes([srid[0], srid[1], srid[2], srid[3]]).to_be_bytes(),
        ),
        _ => return raw,
    };
    let mut out = Vec::with_capacity(raw.len() + 1);
    out.push(order);
    out.extend(kind);
    out.extend(srid);
    out.extend(&raw[9..]);
    out
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02X}")).collect()
}

/// An integer written as text: a number when it fits in 64 bits with a sign, else (an
/// unsigned `BIGINT` past that) its text as a decimal, exact.
fn integer(text: &str) -> Value {
    match text.parse::<i64>() {
        Ok(number) => Value::Integer(number),
        Err(_) => Value::typed(ValueKind::Decimal, text),
    }
}

/// Microseconds as the fraction of a second, with the `digits` of its column (as the text
/// protocol writes them); a column without them, without trailing zeros.
fn fraction(micros: u32, digits: u8) -> String {
    let full = format!("{micros:06}");
    match digits {
        0 => String::new(),
        1..=6 => format!(".{}", &full[..usize::from(digits)]),
        _ if micros == 0 => String::new(),
        _ => format!(".{}", full.trim_end_matches('0')),
    }
}

/// A moment of the binary protocol: a date, or a date and a time as ISO 8601 writes them.
fn moment(kind: ValueKind, parts: (u16, u8, u8, u8, u8, u8, u32), digits: u8) -> Value {
    let (year, month, day, hour, minute, second, micros) = parts;
    let date = format!("{year:04}-{month:02}-{day:02}");
    if kind == ValueKind::Date {
        return Value::typed(kind, date);
    }
    let time = format!(
        "{hour:02}:{minute:02}:{second:02}{}",
        fraction(micros, digits)
    );
    Value::typed(ValueKind::Timestamp, format!("{date}T{time}"))
}

/// A `TIME` of the binary protocol: it may be negative and pass 24 hours.
fn clock(negative: bool, parts: (u32, u8, u8, u8, u32), digits: u8) -> String {
    let (days, hours, minutes, seconds, micros) = parts;
    let hours = days * 24 + u32::from(hours);
    let sign = if negative { "-" } else { "" };
    format!(
        "{sign}{hours:02}:{minutes:02}:{seconds:02}{}",
        fraction(micros, digits)
    )
}

/// The bits of a `BIT` column, most significant byte first.
fn bits(raw: &[u8]) -> u64 {
    raw.iter()
        .fold(0, |sum, byte| (sum << 8) | u64::from(*byte))
}

/// A value of a column, from either protocol.
pub(crate) fn value(value: MyValue, column: &MyColumn) -> Value {
    let kind = kind_of(column);
    match value {
        MyValue::NULL => Value::Null,
        MyValue::Int(number) if kind == ValueKind::Boolean => Value::Bool(number != 0),
        MyValue::Int(number) => Value::Integer(number),
        MyValue::UInt(number) => match i64::try_from(number) {
            Ok(number) if kind == ValueKind::Boolean => Value::Bool(number != 0),
            Ok(number) => Value::Integer(number),
            Err(_) => Value::typed(ValueKind::Decimal, number.to_string()),
        },
        // A float has fewer digits than a double: written as MySQL writes it.
        MyValue::Float(number) => Value::Float(number.to_string().parse().unwrap_or(number.into())),
        MyValue::Double(number) => Value::Float(number),
        MyValue::Date(year, month, day, hour, minute, second, micros) => moment(
            kind,
            (year, month, day, hour, minute, second, micros),
            column.decimals(),
        ),
        MyValue::Time(negative, days, hours, minutes, seconds, micros) => Value::typed(
            ValueKind::Time,
            clock(
                negative,
                (days, hours, minutes, seconds, micros),
                column.decimals(),
            ),
        ),
        MyValue::Bytes(raw) => from_bytes(
            raw,
            kind,
            column.column_type() == ColumnType::MYSQL_TYPE_BIT,
        ),
    }
}

/// A value the server sent as bytes: text for most types, raw for binaries and `BIT`s.
fn from_bytes(raw: Vec<u8>, kind: ValueKind, bit: bool) -> Value {
    match kind {
        ValueKind::Binary => bytes(&raw),
        ValueKind::Spatial => text(ValueKind::Spatial, hex(&ewkb(raw))),
        ValueKind::Boolean if bit => Value::Bool(bits(&raw) != 0),
        ValueKind::Integer if bit => {
            let number = bits(&raw);
            i64::try_from(number).map_or_else(
                |_| Value::typed(ValueKind::Decimal, number.to_string()),
                Value::Integer,
            )
        }
        _ => {
            let written = String::from_utf8(raw)
                .unwrap_or_else(|error| String::from_utf8_lossy(error.as_bytes()).into_owned());
            match kind {
                ValueKind::Integer => integer(&written),
                ValueKind::Float => written
                    .parse::<f64>()
                    .map_or_else(|_| Value::typed(ValueKind::Float, &written), Value::Float),
                // `2026-11-16 10:00:00` as ISO 8601 writes it; a zero date stays as it is.
                ValueKind::Timestamp => Value::typed(kind, written.replacen(' ', "T", 1)),
                ValueKind::Text => text(ValueKind::Text, written),
                other => text(other, written),
            }
        }
    }
}
