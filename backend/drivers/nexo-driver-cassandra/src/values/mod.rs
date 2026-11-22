//! CQL values as the values of the drivers, without loss: `varint`, `decimal` and the 64-bit
//! integers beyond JSON as typed text, `uuid` and `timeuuid`, `timestamp`, `date`, `time`,
//! `duration`, `inet` and `blob`; collections and tuples as arrays, maps and user types as
//! JSON. And the other way: a bound value written as the type the statement expects.
mod bind;
mod numbers;
#[cfg(test)]
mod tests;

pub(crate) use bind::to_cql;
pub(crate) use numbers::timestamp_text;

use nexo_driver_sdk::{Column, Value, ValueKind};
use numbers::{bigint_text, date_text, decimal_text, duration_text, time_text};
use scylla::{
    frame::response::result::{CollectionType, ColumnType, NativeType},
    value::{Counter, CqlTime, CqlTimestamp, CqlValue},
};
use serde_json::{Map, Value as Json, json};

/// A CQL value as JSON inside a collection, map or user type.
fn json(value: &CqlValue) -> Json {
    match from_cql(Some(value)) {
        Value::Typed {
            text,
            kind: ValueKind::Json,
            ..
        } => serde_json::from_str(&text).unwrap_or(Json::String(text)),
        other => Json::from(other),
    }
}

/// A CQL value as a value of the drivers.
pub(crate) fn from_cql(value: Option<&CqlValue>) -> Value {
    let Some(value) = value else {
        return Value::Null;
    };
    match value {
        CqlValue::Ascii(text) | CqlValue::Text(text) => Value::Text(text.clone()),
        CqlValue::Boolean(flag) => Value::Bool(*flag),
        CqlValue::Blob(bytes) => Value::bytes(bytes),
        CqlValue::Counter(Counter(count)) | CqlValue::BigInt(count) => Value::Integer(*count),
        CqlValue::Int(int) => Value::Integer(i64::from(*int)),
        CqlValue::SmallInt(int) => Value::Integer(i64::from(*int)),
        CqlValue::TinyInt(int) => Value::Integer(i64::from(*int)),
        CqlValue::Varint(varint) => Value::typed(
            ValueKind::Integer,
            bigint_text(varint.as_signed_bytes_be_slice()),
        ),
        CqlValue::Decimal(decimal) => Value::typed(ValueKind::Decimal, decimal_text(decimal)),
        CqlValue::Double(float) => Value::Float(*float),
        CqlValue::Float(float) => Value::Float(f64::from(*float)),
        CqlValue::Date(date) => Value::typed(ValueKind::Date, date_text(*date)),
        CqlValue::Time(CqlTime(nanos)) => Value::typed(ValueKind::Time, time_text(*nanos)),
        CqlValue::Timestamp(CqlTimestamp(millis)) => {
            Value::typed(ValueKind::Timestamptz, timestamp_text(*millis))
        }
        CqlValue::Duration(duration) => Value::typed(ValueKind::Interval, duration_text(duration)),
        CqlValue::Uuid(uuid) => Value::typed(ValueKind::Uuid, uuid.to_string()),
        CqlValue::Timeuuid(uuid) => Value::typed(ValueKind::Uuid, uuid.as_ref().to_string()),
        CqlValue::Inet(address) => Value::Text(address.to_string()),
        CqlValue::Empty => Value::Null,
        CqlValue::List(items) | CqlValue::Set(items) | CqlValue::Vector(items) => {
            Value::Array(items.iter().map(|item| from_cql(Some(item))).collect())
        }
        CqlValue::Tuple(items) => {
            Value::Array(items.iter().map(|item| from_cql(item.as_ref())).collect())
        }
        CqlValue::Map(pairs) => {
            let text_keys = pairs
                .iter()
                .all(|(key, _)| matches!(key, CqlValue::Text(_) | CqlValue::Ascii(_)));
            let text = if text_keys {
                let object: Map<String, Json> = pairs
                    .iter()
                    .map(|(key, value)| {
                        (
                            key.as_text()
                                .or(key.as_ascii())
                                .cloned()
                                .unwrap_or_default(),
                            json(value),
                        )
                    })
                    .collect();
                Json::Object(object).to_string()
            } else {
                Json::Array(
                    pairs
                        .iter()
                        .map(|(key, value)| json!([json(key), json(value)]))
                        .collect(),
                )
                .to_string()
            };
            Value::typed(ValueKind::Json, text)
        }
        CqlValue::UserDefinedType { fields, .. } => {
            let object: Map<String, Json> = fields
                .iter()
                .map(|(name, value)| (name.clone(), value.as_ref().map_or(Json::Null, json)))
                .collect();
            Value::typed(ValueKind::Json, Json::Object(object).to_string())
        }
        other => Value::Text(format!("{other:?}")),
    }
}

/// The name and kind of a CQL type, for the columns of a result.
pub(crate) fn column_type(typ: &ColumnType) -> (String, ValueKind) {
    match typ {
        ColumnType::Native(native) => {
            let (name, kind) = match native {
                NativeType::Ascii => ("ascii", ValueKind::Text),
                NativeType::Text => ("text", ValueKind::Text),
                NativeType::Boolean => ("boolean", ValueKind::Boolean),
                NativeType::Blob => ("blob", ValueKind::Binary),
                NativeType::Counter => ("counter", ValueKind::Integer),
                NativeType::Date => ("date", ValueKind::Date),
                NativeType::Decimal => ("decimal", ValueKind::Decimal),
                NativeType::Double => ("double", ValueKind::Float),
                NativeType::Duration => ("duration", ValueKind::Interval),
                NativeType::Float => ("float", ValueKind::Float),
                NativeType::Int => ("int", ValueKind::Integer),
                NativeType::BigInt => ("bigint", ValueKind::Integer),
                NativeType::Timestamp => ("timestamp", ValueKind::Timestamptz),
                NativeType::Inet => ("inet", ValueKind::Text),
                NativeType::SmallInt => ("smallint", ValueKind::Integer),
                NativeType::TinyInt => ("tinyint", ValueKind::Integer),
                NativeType::Time => ("time", ValueKind::Time),
                NativeType::Timeuuid => ("timeuuid", ValueKind::Uuid),
                NativeType::Uuid => ("uuid", ValueKind::Uuid),
                NativeType::Varint => ("varint", ValueKind::Integer),
                _ => ("custom", ValueKind::Other),
            };
            (name.into(), kind)
        }
        ColumnType::Collection { typ, .. } => match typ {
            CollectionType::List(item) => {
                (format!("list<{}>", column_type(item).0), ValueKind::Array)
            }
            CollectionType::Set(item) => {
                (format!("set<{}>", column_type(item).0), ValueKind::Array)
            }
            CollectionType::Map(key, value) => (
                format!("map<{}, {}>", column_type(key).0, column_type(value).0),
                ValueKind::Json,
            ),
            _ => ("collection".into(), ValueKind::Json),
        },
        ColumnType::Vector { typ, dimensions } => (
            format!("vector<{}, {dimensions}>", column_type(typ).0),
            ValueKind::Array,
        ),
        ColumnType::UserDefinedType { definition, .. } => {
            (definition.name.to_string(), ValueKind::Json)
        }
        ColumnType::Tuple(items) => (
            format!(
                "tuple<{}>",
                items
                    .iter()
                    .map(|item| column_type(item).0)
                    .collect::<Vec<_>>()
                    .join(", ")
            ),
            ValueKind::Array,
        ),
        _ => ("custom".into(), ValueKind::Other),
    }
}

pub(crate) fn column(name: &str, typ: &ColumnType) -> Column {
    let (type_name, kind) = column_type(typ);
    Column::new(name, type_name, kind)
}
