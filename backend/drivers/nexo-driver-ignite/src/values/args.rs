//! The arguments of a statement, as the Java client sends them: one tuple with three elements
//! per argument (its type, its scale and its value), every element null for a null.
use super::{
    BOOLEAN, BYTE_ARRAY, DATE, DATETIME, DECIMAL, DOUBLE, INT64, STRING, TIME, TIMESTAMP, UUID,
    decimal, time,
};
use crate::{msgpack::uuid_bytes, tuple::Builder};
use nexo_driver_sdk::{DriverError, Result, Value, ValueKind};

fn wrong(kind: ValueKind, text: &str) -> DriverError {
    DriverError::invalid(format!("{text} is not a value of kind {kind:?}"))
}

fn typed(builder: &mut Builder, id: i64, scale: i64, value: &[u8]) {
    builder.int(id).int(scale).raw(value);
}

fn append(builder: &mut Builder, value: &Value) -> Result<()> {
    match value {
        Value::Null => {
            builder.null().null().null();
        }
        Value::Bool(value) => typed(builder, BOOLEAN, 0, &[u8::from(*value)]),
        Value::Integer(value) => {
            builder.int(INT64).int(0).int(*value);
        }
        Value::Float(value) => typed(builder, DOUBLE, 0, &value.to_le_bytes()),
        Value::Text(text) => {
            builder.int(STRING).int(0).varlen(text.as_bytes());
        }
        Value::Typed { kind, text, .. } => {
            let kind = *kind;
            let fail = || wrong(kind, text);
            match kind {
                ValueKind::Integer => match text.trim().parse::<i64>() {
                    Ok(number) => {
                        builder.int(INT64).int(0).int(number);
                    }
                    // Past 64 bits: a decimal without a fraction.
                    Err(_) => {
                        let (scale, element) = decimal::element(text).ok_or_else(fail)?;
                        typed(builder, DECIMAL, i64::from(scale), &element);
                    }
                },
                ValueKind::Decimal => {
                    let (scale, element) = decimal::element(text).ok_or_else(fail)?;
                    typed(builder, DECIMAL, i64::from(scale), &element);
                }
                ValueKind::Float => {
                    let number: f64 = text.trim().parse().map_err(|_| fail())?;
                    typed(builder, DOUBLE, 0, &number.to_le_bytes());
                }
                ValueKind::Boolean => {
                    let flag = match text.trim().to_ascii_lowercase().as_str() {
                        "true" | "1" => true,
                        "false" | "0" => false,
                        _ => return Err(fail()),
                    };
                    typed(builder, BOOLEAN, 0, &[u8::from(flag)]);
                }
                ValueKind::Date => {
                    typed(builder, DATE, 0, &time::date_bytes(text).ok_or_else(fail)?)
                }
                ValueKind::Time => {
                    typed(builder, TIME, 0, &time::time_bytes(text).ok_or_else(fail)?)
                }
                ValueKind::Timestamp => {
                    let element = time::datetime_bytes(text).ok_or_else(fail)?;
                    typed(builder, DATETIME, 0, &element);
                }
                ValueKind::Timestamptz => {
                    let element = time::instant_bytes(text).ok_or_else(fail)?;
                    typed(builder, TIMESTAMP, 0, &element);
                }
                ValueKind::Uuid => {
                    let element = uuid_bytes(text.trim()).ok_or_else(fail)?;
                    typed(builder, UUID, 0, &element);
                }
                ValueKind::Binary => {
                    let bytes = value.as_bytes().ok_or_else(fail)?;
                    builder.int(BYTE_ARRAY).int(0).varlen(&bytes);
                }
                ValueKind::Interval => {
                    return Err(DriverError::unsupported(
                        "Write an interval in the statement, such as INTERVAL '2' DAY",
                    ));
                }
                _ => {
                    builder.int(STRING).int(0).varlen(text.as_bytes());
                }
            }
        }
        Value::Array(_) => {
            return Err(DriverError::unsupported(
                "Ignite takes no arrays as parameters",
            ));
        }
    }
    Ok(())
}

/// The tuple of the arguments; `None` without any.
pub fn tuple(values: &[Value]) -> Result<Option<Vec<u8>>> {
    if values.is_empty() {
        return Ok(None);
    }
    let mut builder = Builder::default();
    for value in values {
        append(&mut builder, value)?;
    }
    Ok(Some(builder.build()))
}
