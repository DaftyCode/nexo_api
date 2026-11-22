//! A bound value written as the type the statement expects there.
use super::{
    column_type,
    numbers::{DATE_EPOCH, bigint_bytes, days_from_civil},
};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use nexo_driver_sdk::{DriverError, Result, Value, ValueKind};
use scylla::{
    frame::response::result::{ColumnType, NativeType},
    value::{
        Counter, CqlDate, CqlDecimal, CqlTime, CqlTimestamp, CqlTimeuuid, CqlValue, CqlVarint,
    },
};

fn invalid(what: &str, value: &Value) -> DriverError {
    DriverError::invalid(format!("{value:?} is not a value of type {what}"))
}

/// The text of a bound value, whatever form it came in.
fn text_of(value: &Value) -> Option<String> {
    match value {
        Value::Text(text) => Some(text.clone()),
        Value::Typed { text, .. } => Some(text.clone()),
        Value::Integer(number) => Some(number.to_string()),
        Value::Float(number) => Some(number.to_string()),
        Value::Bool(flag) => Some(flag.to_string()),
        _ => None,
    }
}

/// A bound value written as the type the statement expects there.
pub(crate) fn to_cql(value: &Value, typ: &ColumnType) -> Result<Option<CqlValue>> {
    if matches!(value, Value::Null) {
        return Ok(None);
    }
    let text = text_of(value);
    let parse = |what: &str| text.clone().ok_or_else(|| invalid(what, value));
    let number = |what: &str| -> Result<i64> {
        parse(what)?
            .trim()
            .parse::<i64>()
            .map_err(|_| invalid(what, value))
    };
    Ok(Some(match typ {
        ColumnType::Native(native) => match native {
            NativeType::Ascii => CqlValue::Ascii(parse("ascii")?),
            NativeType::Text => CqlValue::Text(parse("text")?),
            NativeType::Boolean => match (value, text.as_deref()) {
                (Value::Bool(flag), _) => CqlValue::Boolean(*flag),
                (_, Some("true")) => CqlValue::Boolean(true),
                (_, Some("false")) => CqlValue::Boolean(false),
                _ => return Err(invalid("boolean", value)),
            },
            NativeType::Int => {
                CqlValue::Int(i32::try_from(number("int")?).map_err(|_| invalid("int", value))?)
            }
            NativeType::SmallInt => CqlValue::SmallInt(
                i16::try_from(number("smallint")?).map_err(|_| invalid("smallint", value))?,
            ),
            NativeType::TinyInt => CqlValue::TinyInt(
                i8::try_from(number("tinyint")?).map_err(|_| invalid("tinyint", value))?,
            ),
            NativeType::BigInt => CqlValue::BigInt(number("bigint")?),
            NativeType::Counter => CqlValue::Counter(Counter(number("counter")?)),
            NativeType::Varint => CqlValue::Varint(CqlVarint::from_signed_bytes_be(
                bigint_bytes(parse("varint")?.trim()).ok_or_else(|| invalid("varint", value))?,
            )),
            NativeType::Decimal => {
                let text = parse("decimal")?;
                let (whole, fraction) = text.trim().split_once('.').unwrap_or((text.trim(), ""));
                let bytes = bigint_bytes(&format!("{whole}{fraction}"))
                    .ok_or_else(|| invalid("decimal", value))?;
                CqlValue::Decimal(CqlDecimal::from_signed_be_bytes_and_exponent(
                    bytes,
                    fraction.len() as i32,
                ))
            }
            NativeType::Double => CqlValue::Double(
                parse("double")?
                    .trim()
                    .parse()
                    .map_err(|_| invalid("double", value))?,
            ),
            NativeType::Float => CqlValue::Float(
                parse("float")?
                    .trim()
                    .parse()
                    .map_err(|_| invalid("float", value))?,
            ),
            NativeType::Uuid => CqlValue::Uuid(
                parse("uuid")?
                    .trim()
                    .parse()
                    .map_err(|_| invalid("uuid", value))?,
            ),
            NativeType::Timeuuid => CqlValue::Timeuuid(CqlTimeuuid::from(
                parse("timeuuid")?
                    .trim()
                    .parse::<uuid::Uuid>()
                    .map_err(|_| invalid("timeuuid", value))?,
            )),
            NativeType::Inet => CqlValue::Inet(
                parse("inet")?
                    .trim()
                    .parse()
                    .map_err(|_| invalid("inet", value))?,
            ),
            NativeType::Blob => match value {
                Value::Typed {
                    kind: ValueKind::Binary,
                    ..
                } => CqlValue::Blob(
                    STANDARD
                        .decode(parse("blob")?)
                        .map_err(|_| invalid("blob", value))?,
                ),
                _ => CqlValue::Blob(parse("blob")?.into_bytes()),
            },
            NativeType::Date => {
                let text = parse("date")?;
                let parts: Vec<&str> = text.trim().split('-').collect();
                let [year, month, day] = parts.as_slice() else {
                    return Err(invalid("date (YYYY-MM-DD)", value));
                };
                let (year, month, day) = (
                    year.parse::<i64>().map_err(|_| invalid("date", value))?,
                    month.parse::<u32>().map_err(|_| invalid("date", value))?,
                    day.parse::<u32>().map_err(|_| invalid("date", value))?,
                );
                CqlValue::Date(CqlDate(
                    (days_from_civil(year, month, day) + DATE_EPOCH) as u32,
                ))
            }
            NativeType::Timestamp => match value {
                Value::Integer(millis) => CqlValue::Timestamp(CqlTimestamp(*millis)),
                _ => CqlValue::Timestamp(CqlTimestamp(
                    parse_timestamp(&parse("timestamp")?)
                        .ok_or_else(|| invalid("timestamp (ISO 8601)", value))?,
                )),
            },
            NativeType::Time => {
                let text = parse("time")?;
                let (clock, fraction) = text.trim().split_once('.').unwrap_or((text.trim(), ""));
                let parts: Vec<i64> = clock
                    .split(':')
                    .map(|part| part.parse().unwrap_or(-1))
                    .collect();
                let [hours, minutes, seconds] = parts.as_slice() else {
                    return Err(invalid("time (HH:MM:SS)", value));
                };
                let nanos: i64 = format!("{fraction:0<9}")[..9]
                    .parse()
                    .map_err(|_| invalid("time", value))?;
                CqlValue::Time(CqlTime(
                    ((hours * 60 + minutes) * 60 + seconds) * 1_000_000_000 + nanos,
                ))
            }
            _ => {
                return Err(DriverError::unsupported(format!(
                    "Binding a value of {} is not supported",
                    column_type(typ).0
                )));
            }
        },
        _ => {
            return Err(DriverError::unsupported(format!(
                "Binding a value of {} is not supported: write it in the statement",
                column_type(typ).0
            )));
        }
    }))
}

/// An ISO 8601 moment (`2024-01-02T03:04:05.006Z`, an offset, or a date alone) in milliseconds.
pub(crate) fn parse_timestamp(text: &str) -> Option<i64> {
    let text = text.trim();
    let (date, rest) = text.split_once(['T', ' ']).unwrap_or((text, ""));
    let parts: Vec<&str> = date.split('-').collect();
    let [year, month, day] = parts.as_slice() else {
        return None;
    };
    let days = days_from_civil(year.parse().ok()?, month.parse().ok()?, day.parse().ok()?);
    let (clock, offset) = match rest.find(['Z', '+', '-']) {
        Some(at) => (&rest[..at], &rest[at..]),
        None => (rest, ""),
    };
    let mut millis = days * 86_400_000;
    if !clock.is_empty() {
        let (hms, fraction) = clock.split_once('.').unwrap_or((clock, ""));
        let parts: Vec<i64> = hms
            .split(':')
            .map(|part| part.parse().ok())
            .collect::<Option<_>>()?;
        let seconds =
            parts.first()? * 3600 + parts.get(1).unwrap_or(&0) * 60 + parts.get(2).unwrap_or(&0);
        let fraction: i64 = format!("{fraction:0<3}")[..3].parse().ok()?;
        millis += seconds * 1000 + fraction;
    }
    if let Some(sign @ ('+' | '-')) = offset.chars().next() {
        let digits: String = offset[1..].chars().filter(char::is_ascii_digit).collect();
        let hours: i64 = digits.get(..2)?.parse().ok()?;
        let minutes: i64 = digits.get(2..4).unwrap_or("0").parse().ok()?;
        let shift = (hours * 60 + minutes) * 60_000;
        millis += if sign == '+' { -shift } else { shift };
    }
    Some(millis)
}
