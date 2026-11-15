//! SQL Server values as the protocol carries them, without loss: big integers, decimals and
//! money as typed text, dates in ISO 8601, binaries in Base64, `uniqueidentifier`, `xml`.
use nexo_driver_sdk::{Column, Value, ValueKind, limits};
use tiberius::{ColumnData, ColumnType, FromSql};

/// The name SQL Server gives a type of the result's metadata, and its class.
pub(crate) fn column_type(kind: ColumnType) -> (&'static str, ValueKind) {
    use ColumnType::*;
    match kind {
        Bit | Bitn => ("bit", ValueKind::Boolean),
        Int1 => ("tinyint", ValueKind::Integer),
        Int2 => ("smallint", ValueKind::Integer),
        Int4 => ("int", ValueKind::Integer),
        Int8 => ("bigint", ValueKind::Integer),
        Intn => ("int", ValueKind::Integer),
        Float4 => ("real", ValueKind::Float),
        Float8 | Floatn => ("float", ValueKind::Float),
        Money => ("money", ValueKind::Decimal),
        Money4 => ("smallmoney", ValueKind::Decimal),
        Decimaln => ("decimal", ValueKind::Decimal),
        Numericn => ("numeric", ValueKind::Decimal),
        Datetime4 => ("smalldatetime", ValueKind::Timestamp),
        Datetime | Datetimen => ("datetime", ValueKind::Timestamp),
        Datetime2 => ("datetime2", ValueKind::Timestamp),
        Daten => ("date", ValueKind::Date),
        Timen => ("time", ValueKind::Time),
        DatetimeOffsetn => ("datetimeoffset", ValueKind::Timestamptz),
        Guid => ("uniqueidentifier", ValueKind::Uuid),
        BigVarBin => ("varbinary", ValueKind::Binary),
        BigBinary => ("binary", ValueKind::Binary),
        Image => ("image", ValueKind::Binary),
        BigVarChar => ("varchar", ValueKind::Text),
        BigChar => ("char", ValueKind::Text),
        Text => ("text", ValueKind::Text),
        NVarchar => ("nvarchar", ValueKind::Text),
        NChar => ("nchar", ValueKind::Text),
        NText => ("ntext", ValueKind::Text),
        Xml => ("xml", ValueKind::Xml),
        Udt => ("udt", ValueKind::Binary),
        SSVariant => ("sql_variant", ValueKind::Other),
        _ => ("unknown", ValueKind::Other),
    }
}

/// The columns of a result, by name and type. SQL Server does not say where they come from.
pub(crate) fn columns(columns: &[tiberius::Column]) -> Vec<Column> {
    columns
        .iter()
        .map(|column| {
            let (name, kind) = column_type(column.column_type());
            Column::new(column.name(), name, kind)
        })
        .collect()
}

/// The exact type of the columns SQL Server sends as "nullable, of some size" (`intn`,
/// `floatn`, `datetimen`), told by a row's values: they come in the size of the column.
pub(crate) fn refine(columns: &mut [Column], row: &tiberius::Row) {
    for (column, (_, data)) in columns.iter_mut().zip(row.cells()) {
        let name = match (column.type_name.as_str(), data) {
            ("int", ColumnData::U8(_)) => "tinyint",
            ("int", ColumnData::I16(_)) => "smallint",
            ("int", ColumnData::I64(_)) => "bigint",
            ("float", ColumnData::F32(_)) => "real",
            ("datetime", ColumnData::SmallDateTime(_)) => "smalldatetime",
            ("datetime", ColumnData::DateTime2(_)) => "datetime2",
            _ => continue,
        };
        column.type_name = name.into();
    }
}

/// ISO 8601 with the decimals of a second it has, and no more (SQL Server keeps up to 7).
fn seconds(text: String) -> String {
    let Some(point) = text.find('.') else {
        return text;
    };
    let digits = text[point + 1..]
        .chars()
        .take_while(char::is_ascii_digit)
        .count();
    let kept = text[point + 1..point + 1 + digits]
        .trim_end_matches('0')
        .len();
    let end = if kept == 0 { point } else { point + 1 + kept };
    format!("{}{}", &text[..end], &text[point + 1 + digits..])
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

/// A value of a cell of a column of type `kind`.
pub(crate) fn value(data: &ColumnData<'static>, kind: ColumnType) -> Value {
    use ColumnData::*;
    let temporal = |value: Option<std::string::String>| {
        value.map_or(Value::Null, |text| Value::typed(time_kind(kind), text))
    };
    match data {
        U8(value) => value.map_or(Value::Null, |n| Value::Integer(n.into())),
        I16(value) => value.map_or(Value::Null, |n| Value::Integer(n.into())),
        I32(value) => value.map_or(Value::Null, |n| Value::Integer(n.into())),
        I64(value) => value.map_or(Value::Null, Value::Integer),
        F32(value) => value.map_or(Value::Null, |n| Value::Float(n.into())),
        // Money arrives as a float with four decimals: written with them, as SQL Server does.
        F64(value) if matches!(kind, ColumnType::Money | ColumnType::Money4) => value
            .map_or(Value::Null, |n| {
                Value::typed(ValueKind::Decimal, format!("{n:.4}"))
            }),
        F64(value) => value.map_or(Value::Null, Value::Float),
        Bit(value) => value.map_or(Value::Null, Value::Bool),
        String(value) => value.as_ref().map_or(Value::Null, |text| {
            self::text(ValueKind::Text, text.to_string())
        }),
        Guid(value) => value.map_or(Value::Null, |id| {
            Value::typed(ValueKind::Uuid, id.to_string())
        }),
        Binary(value) => value.as_ref().map_or(Value::Null, |bytes| {
            if bytes.len() <= limits::VALUE_BYTES {
                Value::bytes(bytes)
            } else {
                let Value::Typed { kind, text, .. } = Value::bytes(&bytes[..limits::VALUE_BYTES])
                else {
                    unreachable!()
                };
                Value::Typed {
                    kind,
                    text,
                    full_size: Some(bytes.len() as u64),
                }
            }
        }),
        Numeric(value) => value.map_or(Value::Null, |n| {
            Value::typed(ValueKind::Decimal, n.to_string())
        }),
        Xml(value) => value.as_ref().map_or(Value::Null, |xml| {
            self::text(ValueKind::Xml, xml.to_string())
        }),
        // datetime keeps 1/300 s: SQL Server shows it rounded to milliseconds.
        DateTime(_) => temporal(
            chrono::NaiveDateTime::from_sql(data)
                .ok()
                .flatten()
                .map(|time| {
                    let rounded = time + chrono::Duration::microseconds(500);
                    seconds(rounded.format("%Y-%m-%dT%H:%M:%S%.3f").to_string())
                }),
        ),
        SmallDateTime(_) | DateTime2(_) => temporal(
            chrono::NaiveDateTime::from_sql(data)
                .ok()
                .flatten()
                .map(|time| seconds(time.format("%Y-%m-%dT%H:%M:%S%.9f").to_string())),
        ),
        Date(_) => temporal(
            chrono::NaiveDate::from_sql(data)
                .ok()
                .flatten()
                .map(|day| day.to_string()),
        ),
        Time(_) => temporal(
            chrono::NaiveTime::from_sql(data)
                .ok()
                .flatten()
                .map(|time| seconds(time.format("%H:%M:%S%.9f").to_string())),
        ),
        DateTimeOffset(_) => temporal(
            chrono::DateTime::<chrono::FixedOffset>::from_sql(data)
                .ok()
                .flatten()
                .map(|time| seconds(time.format("%Y-%m-%dT%H:%M:%S%.9f%:z").to_string())),
        ),
    }
}

fn time_kind(kind: ColumnType) -> ValueKind {
    match kind {
        ColumnType::Daten => ValueKind::Date,
        ColumnType::Timen => ValueKind::Time,
        ColumnType::DatetimeOffsetn => ValueKind::Timestamptz,
        _ => ValueKind::Timestamp,
    }
}

/// A row of a result.
pub(crate) fn row(row: tiberius::Row) -> Vec<Value> {
    let kinds: Vec<ColumnType> = row
        .columns()
        .iter()
        .map(|column| column.column_type())
        .collect();
    row.into_iter()
        .zip(kinds)
        .map(|(data, kind)| value(&data, kind))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::seconds;

    #[test]
    fn writes_the_decimals_of_a_second_it_has() {
        assert_eq!(seconds("10:20:30.123456700".into()), "10:20:30.1234567");
        assert_eq!(
            seconds("2026-11-13T10:20:30.000000000+02:00".into()),
            "2026-11-13T10:20:30+02:00"
        );
        assert_eq!(
            seconds("2026-11-13T10:20:30.120000000".into()),
            "2026-11-13T10:20:30.12"
        );
        assert_eq!(seconds("2026-11-13".into()), "2026-11-13");
    }
}
