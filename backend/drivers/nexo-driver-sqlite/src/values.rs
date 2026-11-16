//! SQLite's values as the driver protocol writes them. SQLite types each value, not each
//! column: a cell says the class of what it holds (integer, real, text, blob or null), and a
//! column carries the type it was declared with. Dates kept as text or numbers are shown as
//! they are.
use nexo_driver_sdk::{Column, Value, ValueKind, limits, value::Origin};
use rusqlite::{
    Statement,
    types::{Value as SqlValue, ValueRef},
};

/// What a declared type holds, by SQLite's rules of affinity (and booleans and dates, which
/// it keeps as numbers or text).
pub(crate) fn kind_of(declared: &str) -> ValueKind {
    let upper = declared.to_ascii_uppercase();
    let has = |part: &str| upper.contains(part);
    if upper.trim().is_empty() {
        ValueKind::Other
    } else if has("INT") {
        ValueKind::Integer
    } else if has("CHAR") || has("CLOB") || has("TEXT") || has("DATE") || has("TIME") {
        ValueKind::Text
    } else if has("BLOB") {
        ValueKind::Binary
    } else if has("REAL") || has("FLOA") || has("DOUB") {
        ValueKind::Float
    } else if has("BOOL") {
        ValueKind::Boolean
    } else {
        ValueKind::Decimal
    }
}

/// The class of a value, as a column without a declared type is named.
fn class_of(value: &Value) -> Option<(&'static str, ValueKind)> {
    match value {
        Value::Integer(_) => Some(("INTEGER", ValueKind::Integer)),
        Value::Float(_) => Some(("REAL", ValueKind::Float)),
        Value::Text(_) => Some(("TEXT", ValueKind::Text)),
        Value::Typed {
            kind: ValueKind::Binary,
            ..
        } => Some(("BLOB", ValueKind::Binary)),
        Value::Typed { kind, .. } => Some(("TEXT", *kind)),
        _ => None,
    }
}

/// The columns of a statement: their declared type, and the table, column and key they come
/// from when they come from a table.
pub(crate) fn columns(statement: &Statement<'_>) -> Vec<Column> {
    let names: Vec<&str> = statement.column_names().collect();
    (0..statement.column_count())
        .map(|index| {
            let name = names.get(index).copied().unwrap_or_default();
            let found = statement.column_metadata(index).ok().flatten();
            let Some((database, table, column, declared, _, not_null, key, _)) = found else {
                return Column::new(name, "", ValueKind::Other);
            };
            let declared = declared
                .map(|text| text.to_string_lossy().into_owned())
                .unwrap_or_default();
            let database = database.to_string_lossy();
            Column {
                nullable: Some(!not_null),
                origin: Some(Origin {
                    schema: (database != "main").then(|| database.into_owned()),
                    table: table.to_string_lossy().into_owned(),
                    column: column.to_string_lossy().into_owned(),
                }),
                key,
                ..Column::new(name, declared.clone(), kind_of(&declared))
            }
        })
        .collect()
}

/// Columns without a declared type (expressions) named after the class of their first value.
pub(crate) fn typed_by_values(columns: &mut [Column], rows: &[Vec<Value>]) {
    for (index, column) in columns.iter_mut().enumerate() {
        if !column.type_name.is_empty() || column.origin.is_some() {
            continue;
        }
        let first = rows
            .iter()
            .filter_map(|row| row.get(index))
            .find_map(class_of);
        if let Some((name, kind)) = first {
            column.type_name = name.into();
            column.kind = kind;
        }
    }
}

/// Text cut at the limit of one value.
fn text(bytes: &[u8]) -> Value {
    let full = String::from_utf8_lossy(bytes);
    if full.len() <= limits::VALUE_BYTES {
        return Value::Text(full.into_owned());
    }
    Value::Text(full.into_owned()).truncated(limits::VALUE_BYTES)
}

/// Bytes cut at the limit of one value.
fn blob(bytes: &[u8]) -> Value {
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

/// A value as SQLite holds it.
pub(crate) fn value(value: ValueRef<'_>) -> Value {
    match value {
        ValueRef::Null => Value::Null,
        ValueRef::Integer(number) => Value::Integer(number),
        ValueRef::Real(number) => Value::Float(number),
        ValueRef::Text(bytes) => text(bytes),
        ValueRef::Blob(bytes) => blob(bytes),
    }
}

/// A value bound to a statement, as SQLite takes it.
pub(crate) fn param(value: &Value) -> SqlValue {
    match value {
        Value::Null => SqlValue::Null,
        Value::Bool(value) => SqlValue::Integer(i64::from(*value)),
        Value::Integer(value) => SqlValue::Integer(*value),
        Value::Float(value) => SqlValue::Real(*value),
        Value::Text(text) => SqlValue::Text(text.clone()),
        Value::Typed {
            kind: ValueKind::Binary,
            ..
        } => SqlValue::Blob(value.as_bytes().unwrap_or_default()),
        Value::Typed { text, .. } => SqlValue::Text(text.clone()),
        Value::Array(_) => SqlValue::Text(serde_json::to_string(value).unwrap_or_default()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_declared_type_has_the_kind_of_its_affinity() {
        for (declared, kind) in [
            ("INTEGER", ValueKind::Integer),
            ("bigint", ValueKind::Integer),
            ("VARCHAR(40)", ValueKind::Text),
            ("DATETIME", ValueKind::Text),
            ("BLOB", ValueKind::Binary),
            ("DOUBLE PRECISION", ValueKind::Float),
            ("BOOLEAN", ValueKind::Boolean),
            ("DECIMAL(10,2)", ValueKind::Decimal),
            ("", ValueKind::Other),
        ] {
            assert_eq!(kind_of(declared), kind, "{declared}");
        }
    }

    #[test]
    fn values_keep_their_class_and_parameters_bind_as_sqlite_takes_them() {
        assert_eq!(value(ValueRef::Integer(1 << 60)), Value::Integer(1 << 60));
        assert_eq!(value(ValueRef::Real(1.5)), Value::Float(1.5));
        assert_eq!(value(ValueRef::Blob(&[0, 255])), Value::bytes(&[0, 255]));
        assert_eq!(
            value(ValueRef::Text(b"a\xFFb")),
            Value::Text("a\u{FFFD}b".into())
        );
        let long = vec![b'x'; limits::VALUE_BYTES + 1];
        assert!(matches!(
            value(ValueRef::Text(&long)),
            Value::Typed { full_size: Some(size), .. } if size == long.len() as u64
        ));
        assert_eq!(param(&Value::Bool(true)), SqlValue::Integer(1));
        assert_eq!(param(&Value::bytes(&[7])), SqlValue::Blob(vec![7]));
        let decimal = Value::typed(ValueKind::Decimal, "1.50");
        assert_eq!(param(&decimal), SqlValue::Text("1.50".into()));
    }

    #[test]
    fn an_expression_is_named_after_its_first_value() {
        let mut columns = vec![Column::new("a", "", ValueKind::Other)];
        typed_by_values(&mut columns, &[vec![Value::Null], vec![Value::Float(2.0)]]);
        assert_eq!(
            (columns[0].type_name.as_str(), columns[0].kind),
            ("REAL", ValueKind::Float)
        );
    }
}
