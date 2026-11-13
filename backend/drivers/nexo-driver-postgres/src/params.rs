//! Bound values, sent in their text form: the server reads each one as the type it inferred
//! for its parameter, so a value never needs to know that type here.
use bytes::BytesMut;
use nexo_driver_sdk::{Value, ValueKind};
use std::error::Error;
use tokio_postgres::types::{Format, IsNull, ToSql, Type, to_sql_checked};

#[derive(Debug)]
pub(crate) struct TextParam(Option<String>);

impl ToSql for TextParam {
    fn to_sql(&self, _: &Type, out: &mut BytesMut) -> Result<IsNull, Box<dyn Error + Sync + Send>> {
        match &self.0 {
            None => Ok(IsNull::Yes),
            Some(text) => {
                out.extend_from_slice(text.as_bytes());
                Ok(IsNull::No)
            }
        }
    }
    fn accepts(_: &Type) -> bool {
        true
    }
    fn encode_format(&self, _: &Type) -> Format {
        Format::Text
    }
    to_sql_checked!();
}

fn quoted_item(value: &Value) -> String {
    match text_of(value) {
        None => "NULL".into(),
        Some(text) if matches!(value, Value::Array(_)) => text,
        Some(text) => format!("\"{}\"", text.replace('\\', "\\\\").replace('"', "\\\"")),
    }
}

/// The text form PostgreSQL reads a value from.
fn text_of(value: &Value) -> Option<String> {
    Some(match value {
        Value::Null => return None,
        Value::Bool(value) => value.to_string(),
        Value::Integer(value) => value.to_string(),
        Value::Float(value) => value.to_string(),
        Value::Text(text) => text.clone(),
        Value::Typed {
            kind: ValueKind::Binary,
            ..
        } => {
            let bytes = value.as_bytes().unwrap_or_default();
            let hex: String = bytes.iter().map(|byte| format!("{byte:02x}")).collect();
            format!("\\x{hex}")
        }
        Value::Typed { text, .. } => text.clone(),
        Value::Array(items) => {
            let items: Vec<String> = items.iter().map(quoted_item).collect();
            format!("{{{}}}", items.join(","))
        }
    })
}

pub(crate) fn param(value: &Value) -> TextParam {
    TextParam(text_of(value))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn values_are_written_as_postgresql_reads_them() {
        let text = |value: Value| text_of(&value);
        assert_eq!(text(Value::Null), None);
        assert_eq!(text(Value::Bool(true)).as_deref(), Some("true"));
        assert_eq!(
            text(Value::Integer(i64::MAX)).as_deref(),
            Some("9223372036854775807")
        );
        assert_eq!(text(Value::bytes(&[0, 255])).as_deref(), Some("\\x00ff"));
        assert_eq!(
            text(Value::typed(ValueKind::Decimal, "1.50")).as_deref(),
            Some("1.50")
        );
        let array = Value::Array(vec![
            Value::Text("a\"b".into()),
            Value::Null,
            Value::Array(vec![Value::Integer(1)]),
        ]);
        assert_eq!(text(array).as_deref(), Some("{\"a\\\"b\",NULL,{\"1\"}}"));
    }
}
