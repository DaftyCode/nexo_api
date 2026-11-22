//! Replies of the server as values that lose nothing: text when it is UTF-8, its bytes
//! (`binary`) when not, numbers, arrays and maps.
use nexo_driver_sdk::{DriverError, Result, Value as Cell};
use redis::Value;
use serde_json::{Map, Value as Json, json};

/// Bytes as a cell: text, or binary.
pub(crate) fn cell(bytes: &[u8]) -> Cell {
    match std::str::from_utf8(bytes) {
        Ok(text) => Cell::Text(text.to_owned()),
        Err(_) => Cell::bytes(bytes),
    }
}

/// A cell's bytes: a key or a value written by the person.
pub(crate) fn bytes(value: &Cell) -> Result<Vec<u8>> {
    match value {
        Cell::Text(text) => Ok(text.as_bytes().to_vec()),
        Cell::Integer(number) => Ok(number.to_string().into_bytes()),
        Cell::Float(number) => Ok(number.to_string().into_bytes()),
        Cell::Bool(flag) => Ok(u8::from(*flag).to_string().into_bytes()),
        Cell::Typed { .. } => value
            .as_bytes()
            .or_else(|| match value {
                Cell::Typed { text, .. } => Some(text.as_bytes().to_vec()),
                _ => None,
            })
            .ok_or_else(|| DriverError::invalid("Unreadable bytes")),
        Cell::Null | Cell::Array(_) => Err(DriverError::invalid("A key or value is text or bytes")),
    }
}

/// The text of a reply that is text.
pub(crate) fn text(value: &Value) -> Option<String> {
    match value {
        Value::BulkString(bytes) => Some(String::from_utf8_lossy(bytes).into_owned()),
        Value::SimpleString(text) => Some(text.clone()),
        Value::VerbatimString { text, .. } => Some(text.clone()),
        Value::Okay => Some("OK".into()),
        Value::Int(number) => Some(number.to_string()),
        _ => None,
    }
}

/// A reply as JSON for the console.
pub(crate) fn json(value: &Value) -> Json {
    match value {
        Value::Nil => Json::Null,
        Value::Int(number) => json!(number),
        Value::BulkString(bytes) => match std::str::from_utf8(bytes) {
            Ok(text) => Json::String(text.to_owned()),
            Err(_) => Json::from(Cell::bytes(bytes)),
        },
        Value::SimpleString(text) => Json::String(text.clone()),
        Value::Okay => Json::String("OK".into()),
        Value::Array(items) | Value::Set(items) => Json::Array(items.iter().map(json).collect()),
        Value::Push { data, .. } => Json::Array(data.iter().map(json).collect()),
        Value::Map(pairs) => {
            // An object when every key is text; pairs otherwise (numbers as keys too).
            let keys: Option<Vec<String>> = pairs
                .iter()
                .map(|(key, _)| match key {
                    Value::Int(_) => None,
                    other => text(other),
                })
                .collect();
            match keys {
                Some(keys) => Json::Object(
                    keys.into_iter()
                        .zip(pairs.iter().map(|(_, value)| json(value)))
                        .collect::<Map<_, _>>(),
                ),
                None => Json::Array(
                    pairs
                        .iter()
                        .map(|(key, value)| json!([json(key), json(value)]))
                        .collect(),
                ),
            }
        }
        Value::Attribute { data, .. } => json(data),
        Value::Double(number) if number.is_finite() => json!(number),
        Value::Double(number) => Json::String(number.to_string()),
        Value::Boolean(flag) => Json::Bool(*flag),
        Value::VerbatimString { text, .. } => Json::String(text.clone()),
        Value::BigNumber(number) => Json::String(format!("{number:?}")),
        Value::ServerError(error) => json!({"error": error.to_string()}),
        _ => Json::String(format!("{value:?}")),
    }
}

/// The items of an array reply.
pub(crate) fn items(value: Value) -> Vec<Value> {
    match value {
        Value::Array(items) | Value::Set(items) => items,
        Value::Map(pairs) => pairs
            .into_iter()
            .flat_map(|(key, value)| [key, value])
            .collect(),
        Value::Nil => Vec::new(),
        other => vec![other],
    }
}

/// The bytes of a reply that is a string.
pub(crate) fn raw(value: &Value) -> Vec<u8> {
    match value {
        Value::BulkString(bytes) => bytes.clone(),
        other => text(other).unwrap_or_default().into_bytes(),
    }
}

pub(crate) fn integer(value: &Value) -> Option<i64> {
    match value {
        Value::Int(number) => Some(*number),
        other => text(other)?.parse().ok(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn replies_keep_their_bytes_and_shapes() {
        assert_eq!(cell(b"abc"), Cell::Text("abc".into()));
        assert_eq!(cell(&[0xff, 0]), Cell::bytes(&[0xff, 0]));
        assert_eq!(bytes(&Cell::bytes(&[0xff, 0])).unwrap(), [0xff, 0]);
        assert_eq!(bytes(&Cell::Integer(7)).unwrap(), b"7");
        assert!(bytes(&Cell::Null).is_err());
        assert_eq!(json(&Value::Okay), json!("OK"));
        assert_eq!(
            json(&Value::BulkString(vec![0xff])),
            json!({"$t": "binary", "v": "/w=="})
        );
        let map = Value::Map(vec![(Value::SimpleString("a".into()), Value::Int(1))]);
        assert_eq!(json(&map), json!({"a": 1}));
        let pairs = Value::Map(vec![(Value::Int(1), Value::Nil)]);
        assert_eq!(json(&pairs), json!([[1, null]]));
        assert_eq!(json(&Value::Double(f64::NAN)), json!("NaN"));
        assert_eq!(items(Value::Nil), Vec::<Value>::new());
        assert_eq!(integer(&Value::BulkString(b"12".to_vec())), Some(12));
    }
}
