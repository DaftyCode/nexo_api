//! DuckDB's results as the protocol carries them: read from the Arrow batches DuckDB streams,
//! numbers that fit as numbers and the rest typed, without loss; nested values as their text.
use duckdb::arrow::{
    array::{Array, ArrayRef, AsArray},
    datatypes::{
        DataType, Float32Type, Float64Type, Int8Type, Int16Type, Int32Type, Int64Type, UInt8Type,
        UInt16Type, UInt32Type, UInt64Type,
    },
    util::display::{ArrayFormatter, FormatOptions},
};
use nexo_driver_sdk::{Column, Value, ValueKind, limits};

/// The class and the DuckDB name of a type, as a column of a result has it.
pub fn kind_of(data_type: &DataType) -> (String, ValueKind) {
    let (name, kind) = match data_type {
        DataType::Boolean => ("BOOLEAN".to_owned(), ValueKind::Boolean),
        DataType::Int8 => ("TINYINT".to_owned(), ValueKind::Integer),
        DataType::Int16 => ("SMALLINT".to_owned(), ValueKind::Integer),
        DataType::Int32 => ("INTEGER".to_owned(), ValueKind::Integer),
        DataType::Int64 => ("BIGINT".to_owned(), ValueKind::Integer),
        DataType::UInt8 => ("UTINYINT".to_owned(), ValueKind::Integer),
        DataType::UInt16 => ("USMALLINT".to_owned(), ValueKind::Integer),
        DataType::UInt32 => ("UINTEGER".to_owned(), ValueKind::Integer),
        DataType::UInt64 => ("UBIGINT".to_owned(), ValueKind::Integer),
        DataType::Float16 | DataType::Float32 => ("FLOAT".to_owned(), ValueKind::Float),
        DataType::Float64 => ("DOUBLE".to_owned(), ValueKind::Float),
        DataType::Decimal128(p, s) | DataType::Decimal256(p, s) => {
            (format!("DECIMAL({p},{s})"), ValueKind::Decimal)
        }
        DataType::Utf8 | DataType::LargeUtf8 | DataType::Utf8View => {
            ("VARCHAR".to_owned(), ValueKind::Text)
        }
        DataType::Binary
        | DataType::LargeBinary
        | DataType::BinaryView
        | DataType::FixedSizeBinary(_) => ("BLOB".to_owned(), ValueKind::Binary),
        DataType::Date32 | DataType::Date64 => ("DATE".to_owned(), ValueKind::Date),
        DataType::Timestamp(_, Some(_)) => (
            "TIMESTAMP WITH TIME ZONE".to_owned(),
            ValueKind::Timestamptz,
        ),
        DataType::Timestamp(_, None) => ("TIMESTAMP".to_owned(), ValueKind::Timestamp),
        DataType::Time32(_) | DataType::Time64(_) => ("TIME".to_owned(), ValueKind::Time),
        DataType::Interval(_) | DataType::Duration(_) => {
            ("INTERVAL".to_owned(), ValueKind::Interval)
        }
        DataType::List(_) | DataType::LargeList(_) | DataType::FixedSizeList(..) => {
            ("LIST".to_owned(), ValueKind::Array)
        }
        DataType::Struct(_) => ("STRUCT".to_owned(), ValueKind::Other),
        DataType::Map(..) => ("MAP".to_owned(), ValueKind::Other),
        other => (other.to_string(), ValueKind::Other),
    };
    (name, kind)
}

pub fn columns(schema: &duckdb::arrow::datatypes::Schema) -> Vec<Column> {
    schema
        .fields()
        .iter()
        .map(|field| {
            let (name, kind) = kind_of(field.data_type());
            let mut column = Column::new(field.name(), name, kind);
            column.nullable = Some(field.is_nullable());
            column
        })
        .collect()
}

/// A text value, cut at the limit of one value.
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

/// An integer as a number when JSON keeps it whole, else as a typed decimal.
fn integer(value: i128) -> Value {
    const SAFE: i128 = (1 << 53) - 1;
    if (-SAFE..=SAFE).contains(&value) {
        Value::Integer(value as i64)
    } else {
        Value::typed(ValueKind::Decimal, value.to_string())
    }
}

/// The value at `row` of a column of a batch.
pub fn value(array: &ArrayRef, row: usize, kind: ValueKind) -> Value {
    if array.is_null(row) || array.data_type() == &DataType::Null {
        return Value::Null;
    }
    match array.data_type() {
        DataType::Boolean => return Value::Bool(array.as_boolean().value(row)),
        DataType::Int8 => return integer(array.as_primitive::<Int8Type>().value(row).into()),
        DataType::Int16 => return integer(array.as_primitive::<Int16Type>().value(row).into()),
        DataType::Int32 => return integer(array.as_primitive::<Int32Type>().value(row).into()),
        DataType::Int64 => return integer(array.as_primitive::<Int64Type>().value(row).into()),
        DataType::UInt8 => return integer(array.as_primitive::<UInt8Type>().value(row).into()),
        DataType::UInt16 => return integer(array.as_primitive::<UInt16Type>().value(row).into()),
        DataType::UInt32 => return integer(array.as_primitive::<UInt32Type>().value(row).into()),
        DataType::UInt64 => return integer(array.as_primitive::<UInt64Type>().value(row).into()),
        DataType::Float32 => {
            let number = f64::from(array.as_primitive::<Float32Type>().value(row));
            if number.is_finite() {
                return Value::Float(number);
            }
        }
        DataType::Float64 => {
            let number = array.as_primitive::<Float64Type>().value(row);
            if number.is_finite() {
                return Value::Float(number);
            }
        }
        DataType::Utf8 => {
            return text(
                ValueKind::Text,
                array.as_string::<i32>().value(row).to_owned(),
            );
        }
        DataType::LargeUtf8 => {
            return text(
                ValueKind::Text,
                array.as_string::<i64>().value(row).to_owned(),
            );
        }
        // A HUGEINT (a sum of integers) comes as a decimal without decimals.
        DataType::Decimal128(_, 0) => {
            return integer(
                array
                    .as_primitive::<duckdb::arrow::datatypes::Decimal128Type>()
                    .value(row),
            );
        }
        DataType::Binary => return bytes(array.as_binary::<i32>().value(row)),
        DataType::LargeBinary => return bytes(array.as_binary::<i64>().value(row)),
        _ => {}
    }
    let options = FormatOptions::default();
    let shown = ArrayFormatter::try_new(array.as_ref(), &options)
        .map(|formatter| formatter.value(row).to_string())
        .unwrap_or_default();
    // Dates and times in ISO 8601, with a `T` as the other drivers send them.
    let shown = match kind {
        ValueKind::Timestamp | ValueKind::Timestamptz => shown.replacen(' ', "T", 1),
        _ => shown,
    };
    text(
        if kind == ValueKind::Array {
            ValueKind::Other
        } else {
            kind
        },
        shown,
    )
}

fn bytes(raw: &[u8]) -> Value {
    if raw.len() <= limits::VALUE_BYTES {
        return Value::bytes(raw);
    }
    let Value::Typed { kind, text, .. } = Value::bytes(&raw[..limits::VALUE_BYTES]) else {
        unreachable!()
    };
    Value::Typed {
        kind,
        text,
        full_size: Some(raw.len() as u64),
    }
}

/// A bound parameter as DuckDB takes it.
pub fn param(value: &Value) -> duckdb::types::Value {
    use duckdb::types::Value as Duck;
    match value {
        Value::Null => Duck::Null,
        Value::Bool(value) => Duck::Boolean(*value),
        Value::Integer(value) => Duck::BigInt(*value),
        Value::Float(value) => Duck::Double(*value),
        Value::Text(text) => Duck::Text(text.clone()),
        Value::Typed {
            kind: ValueKind::Binary,
            ..
        } => Duck::Blob(value.as_bytes().unwrap_or_default()),
        Value::Typed { text, .. } => Duck::Text(text.clone()),
        Value::Array(items) => Duck::Text(
            serde_json::to_string(
                &items
                    .iter()
                    .map(|item| serde_json::json!(item))
                    .collect::<Vec<_>>(),
            )
            .unwrap_or_default(),
        ),
    }
}
