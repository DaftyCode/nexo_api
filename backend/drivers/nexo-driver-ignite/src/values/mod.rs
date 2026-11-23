//! Ignite's column types (`ColumnType`, by the number the protocol sends) as the columns and
//! values of the SDK, keeping each type: integers as integers, decimals at their scale, dates,
//! times and instants as typed text, UUIDs, binaries in Base64 and intervals as Java writes
//! them.
pub mod args;
pub mod decimal;
pub mod time;

use crate::tuple::{Tuple, varlen};
use nexo_driver_sdk::{Column, Value, ValueKind, limits, value::Origin};

pub const BOOLEAN: i64 = 1;
pub const INT8: i64 = 2;
pub const INT16: i64 = 3;
pub const INT32: i64 = 4;
pub const INT64: i64 = 5;
pub const FLOAT: i64 = 6;
pub const DOUBLE: i64 = 7;
pub const DECIMAL: i64 = 8;
pub const DATE: i64 = 9;
pub const TIME: i64 = 10;
pub const DATETIME: i64 = 11;
pub const TIMESTAMP: i64 = 12;
pub const UUID: i64 = 13;
pub const STRING: i64 = 15;
pub const BYTE_ARRAY: i64 = 16;
pub const PERIOD: i64 = 17;
pub const DURATION: i64 = 18;

/// A column as the server describes it in a result.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Field {
    pub name: String,
    pub nullable: bool,
    pub type_id: i64,
    pub scale: i64,
    pub precision: i64,
    /// The schema, table and column it comes from, when it is one of a table.
    pub origin: Option<(String, String, String)>,
}

/// The type as Ignite's SQL writes it.
pub fn type_name(id: i64, precision: i64, scale: i64) -> String {
    let sized = |name: &str| {
        if precision > 0 {
            format!("{name}({precision})")
        } else {
            name.to_owned()
        }
    };
    match id {
        0 => "NULL".into(),
        BOOLEAN => "BOOLEAN".into(),
        INT8 => "TINYINT".into(),
        INT16 => "SMALLINT".into(),
        INT32 => "INTEGER".into(),
        INT64 => "BIGINT".into(),
        FLOAT => "REAL".into(),
        DOUBLE => "DOUBLE".into(),
        DECIMAL if precision > 0 => format!("DECIMAL({precision}, {scale})"),
        DECIMAL => "DECIMAL".into(),
        DATE => "DATE".into(),
        TIME => sized("TIME"),
        DATETIME => sized("TIMESTAMP"),
        TIMESTAMP => format!("{} WITH LOCAL TIME ZONE", sized("TIMESTAMP")),
        UUID => "UUID".into(),
        STRING => sized("VARCHAR"),
        BYTE_ARRAY => sized("VARBINARY"),
        PERIOD => "INTERVAL YEAR TO MONTH".into(),
        DURATION => "INTERVAL DAY TO SECOND".into(),
        _ => format!("TYPE {id}"),
    }
}

pub fn kind(id: i64) -> ValueKind {
    match id {
        BOOLEAN => ValueKind::Boolean,
        INT8..=INT64 => ValueKind::Integer,
        FLOAT | DOUBLE => ValueKind::Float,
        DECIMAL => ValueKind::Decimal,
        DATE => ValueKind::Date,
        TIME => ValueKind::Time,
        DATETIME => ValueKind::Timestamp,
        TIMESTAMP => ValueKind::Timestamptz,
        UUID => ValueKind::Uuid,
        STRING => ValueKind::Text,
        BYTE_ARRAY => ValueKind::Binary,
        PERIOD | DURATION => ValueKind::Interval,
        _ => ValueKind::Other,
    }
}

impl Field {
    pub fn column(&self) -> Column {
        let mut column = Column::new(
            self.name.clone(),
            type_name(self.type_id, self.precision, self.scale),
            kind(self.type_id),
        );
        column.nullable = Some(self.nullable);
        column.origin = self.origin.as_ref().map(|(schema, table, name)| Origin {
            schema: Some(schema.clone()),
            table: table.clone(),
            column: name.clone(),
        });
        column
    }
}

/// A little-endian integer of 1, 2, 4 or 8 bytes, with its sign.
pub fn integer(bytes: &[u8]) -> Option<i64> {
    Some(match bytes.len() {
        1 => i64::from(bytes[0] as i8),
        2 => i64::from(i16::from_le_bytes(bytes.try_into().ok()?)),
        4 => i64::from(i32::from_le_bytes(bytes.try_into().ok()?)),
        8 => i64::from_le_bytes(bytes.try_into().ok()?),
        _ => return None,
    })
}

/// A float as its shortest text reads, so a `REAL` of 0.1 stays 0.1.
fn float(bytes: &[u8]) -> Option<f64> {
    match bytes.len() {
        4 => f32::from_le_bytes(bytes.try_into().ok()?)
            .to_string()
            .parse()
            .ok(),
        8 => Some(f64::from_le_bytes(bytes.try_into().ok()?)),
        _ => None,
    }
}

fn binary(bytes: &[u8]) -> Value {
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

/// The value of an element of a row, by its column's type.
pub fn cell(bytes: Option<&[u8]>, field: &Field) -> Option<Value> {
    let Some(bytes) = bytes else {
        return Some(Value::Null);
    };
    let typed = |kind, text: Option<String>| text.map(|text| Value::typed(kind, text));
    match field.type_id {
        BOOLEAN => Some(Value::Bool(*bytes.first()? != 0)),
        INT8..=INT64 => integer(bytes).map(Value::Integer),
        FLOAT | DOUBLE => float(bytes).map(Value::Float),
        DECIMAL => typed(ValueKind::Decimal, decimal::text(bytes, field.scale)),
        DATE => typed(ValueKind::Date, time::date(bytes)),
        TIME => typed(ValueKind::Time, time::time(bytes)),
        DATETIME => typed(ValueKind::Timestamp, time::datetime(bytes)),
        TIMESTAMP => typed(ValueKind::Timestamptz, time::instant(bytes)),
        UUID => (bytes.len() == 16)
            .then(|| Value::typed(ValueKind::Uuid, crate::msgpack::uuid_text(bytes))),
        STRING => {
            let text = String::from_utf8_lossy(varlen(bytes)).into_owned();
            Some(Value::Text(text).truncated(limits::VALUE_BYTES))
        }
        BYTE_ARRAY => Some(binary(varlen(bytes))),
        PERIOD => typed(ValueKind::Interval, time::period(bytes)),
        DURATION => typed(ValueKind::Interval, time::duration(bytes)),
        _ => Some(Value::Null),
    }
}

/// The values of a row, by its columns.
pub fn row(bytes: &[u8], fields: &[Field]) -> nexo_driver_sdk::Result<Vec<Value>> {
    let tuple = Tuple::parse(bytes, fields.len())?;
    fields
        .iter()
        .enumerate()
        .map(|(index, field)| {
            cell(tuple.get(index), field)
                .ok_or_else(|| crate::msgpack::broken(&format!("a value of column {}", field.name)))
        })
        .collect()
}

#[cfg(test)]
mod tests;
