//! What HiveServer2 answers as columns (`TTableSchema`) and rows (`TRowSet`, by columns since
//! protocol 6, each with a bitmap of its nulls) as the columns and values of the SDK, keeping
//! each type: integers as integers, decimals and dates as typed text, binaries as bytes, and
//! arrays, maps and structs as the JSON Hive writes them.
use crate::thrift::Thrift;
use nexo_driver_sdk::{Column, Value, ValueKind};

/// `TTypeId` of `TCLIService.thrift`, by its number.
pub fn type_name(id: i32) -> &'static str {
    match id {
        0 => "boolean",
        1 => "tinyint",
        2 => "smallint",
        3 => "int",
        4 => "bigint",
        5 => "float",
        6 => "double",
        7 => "string",
        8 => "timestamp",
        9 => "binary",
        10 => "array",
        11 => "map",
        12 => "struct",
        13 => "uniontype",
        14 => "user_defined",
        15 => "decimal",
        16 => "void",
        17 => "date",
        18 => "varchar",
        19 => "char",
        20 => "interval_year_month",
        21 => "interval_day_time",
        22 => "timestamp with local time zone",
        _ => "unknown",
    }
}

fn kind_of(id: i32) -> ValueKind {
    match id {
        0 => ValueKind::Boolean,
        1..=4 => ValueKind::Integer,
        5 | 6 => ValueKind::Float,
        8 => ValueKind::Timestamp,
        22 => ValueKind::Timestamptz,
        9 => ValueKind::Binary,
        10..=13 => ValueKind::Json,
        15 => ValueKind::Decimal,
        17 => ValueKind::Date,
        20 | 21 => ValueKind::Interval,
        _ => ValueKind::Text,
    }
}

/// The columns of a schema: each `TColumnDesc` with the first entry of its type.
pub fn columns(schema: &Thrift) -> Vec<Column> {
    let mut found: Vec<(i32, Column)> = schema
        .field(1)
        .map(Thrift::list)
        .unwrap_or_default()
        .iter()
        .map(|column| {
            let name = column.field(1).and_then(Thrift::string).unwrap_or_default();
            let position = column.field(3).and_then(Thrift::i32).unwrap_or(0);
            let entry = column
                .field(2)
                .and_then(|desc| desc.field(1))
                .map(Thrift::list)
                .and_then(<[Thrift]>::first);
            // A primitive entry has its type id; arrays, maps and structs are JSON.
            let id = match entry {
                Some(entry) => match entry.field(1) {
                    Some(primitive) => primitive.field(1).and_then(Thrift::i32).unwrap_or(7),
                    None if entry.field(2).is_some() => 10,
                    None if entry.field(3).is_some() => 11,
                    None if entry.field(4).is_some() => 12,
                    None => 13,
                },
                None => 7,
            };
            let mut type_name = type_name(id).to_owned();
            // `decimal(10,2)`, `varchar(20)`: the qualifiers of the primitive entry.
            if let Some(qualifiers) = entry
                .and_then(|entry| entry.field(1))
                .and_then(|primitive| primitive.field(2))
                .and_then(|qualifiers| qualifiers.field(1))
            {
                let read = |key: &str| match qualifiers {
                    Thrift::Map(_, _, entries) => entries
                        .iter()
                        .find(|(name, _)| name.bytes() == Some(key.as_bytes()))
                        .and_then(|(_, value)| value.field(1).and_then(Thrift::i32)),
                    _ => None,
                };
                match (
                    read("precision"),
                    read("scale"),
                    read("characterMaximumLength"),
                ) {
                    (Some(precision), Some(scale), _) => {
                        type_name = format!("{type_name}({precision},{scale})")
                    }
                    (_, _, Some(length)) => type_name = format!("{type_name}({length})"),
                    _ => {}
                }
            }
            (position, Column::new(name, type_name, kind_of(id)))
        })
        .collect();
    found.sort_by_key(|(position, _)| *position);
    found.into_iter().map(|(_, column)| column).collect()
}

/// Whether row `index` is null in a column's bitmap (bit 0 of byte 0 is the first row).
fn is_null(nulls: &[u8], index: usize) -> bool {
    nulls
        .get(index / 8)
        .is_some_and(|byte| byte & (1 << (index % 8)) != 0)
}

/// A value of a column, by the column's kind.
fn cell(value: &Thrift, kind: ValueKind) -> Value {
    match value {
        Thrift::Bool(value) => Value::Bool(*value),
        Thrift::Byte(value) => Value::Integer(i64::from(*value)),
        Thrift::I16(value) => Value::Integer(i64::from(*value)),
        Thrift::I32(value) => Value::Integer(i64::from(*value)),
        Thrift::I64(value) => Value::Integer(*value),
        Thrift::Double(value) => Value::Float(*value),
        Thrift::Bytes(bytes) if kind == ValueKind::Binary => Value::bytes(bytes),
        Thrift::Bytes(bytes) => {
            let text = String::from_utf8_lossy(bytes).into_owned();
            match kind {
                ValueKind::Text => Value::Text(text),
                kind => Value::typed(kind, text),
            }
        }
        _ => Value::Null,
    }
}

/// The rows of a row set, read from its columns.
pub fn rows(set: &Thrift, columns: &[Column]) -> Vec<Vec<Value>> {
    let lists: Vec<(&[Thrift], &[u8])> = set
        .field(3)
        .map(Thrift::list)
        .unwrap_or_default()
        .iter()
        .map(|column| {
            // A `TColumn` union: one of its fields, a struct with the values and the nulls.
            let typed = match column {
                Thrift::Struct(fields) => fields.values().next(),
                _ => None,
            };
            let values = typed.and_then(|typed| typed.field(1)).map(Thrift::list);
            let nulls = typed
                .and_then(|typed| typed.field(2))
                .and_then(Thrift::bytes);
            (values.unwrap_or_default(), nulls.unwrap_or_default())
        })
        .collect();
    let count = lists.first().map(|(values, _)| values.len()).unwrap_or(0);
    (0..count)
        .map(|row| {
            lists
                .iter()
                .enumerate()
                .map(|(at, (values, nulls))| match values.get(row) {
                    Some(_) if is_null(nulls, row) => Value::Null,
                    Some(value) => {
                        let kind = columns.get(at).map(|c| c.kind).unwrap_or(ValueKind::Text);
                        cell(value, kind)
                    }
                    None => Value::Null,
                })
                .collect()
        })
        .collect()
}
