//! PostgreSQL's values, read in their binary form, as typed values that lose nothing: exact
//! numbers, dates in ISO 8601, binary data, JSON as its text, arrays of any type, ranges,
//! network addresses, enums, composites, `hstore` and PostGIS geometries.
mod compound;
mod numbers;
mod time;

use compound::{composite, nest, range};
use fallible_iterator::FallibleIterator;
use nexo_driver_sdk::{Column, Value, ValueKind, limits, value::Origin};
use postgres_protocol::types as wire;
use std::{error::Error, net::IpAddr};
use tokio_postgres::{
    Column as PgColumn, Row,
    types::{FromSql, Kind, Type},
};

pub(crate) type Decoded<T> = Result<T, Box<dyn Error + Sync + Send>>;

/// A value as it came, whatever its type.
struct Raw<'a>(&'a [u8]);
impl<'a> FromSql<'a> for Raw<'a> {
    fn from_sql(_: &Type, raw: &'a [u8]) -> Decoded<Self> {
        Ok(Raw(raw))
    }
    fn accepts(_: &Type) -> bool {
        true
    }
}

/// What a type is, for the interface.
pub(crate) fn kind_of(ty: &Type) -> ValueKind {
    match ty.kind() {
        Kind::Array(_) => return ValueKind::Other,
        Kind::Domain(base) => return kind_of(base),
        Kind::Enum(_) => return ValueKind::Text,
        _ => {}
    }
    match *ty {
        Type::BOOL => ValueKind::Boolean,
        Type::INT2 | Type::INT4 | Type::INT8 | Type::OID => ValueKind::Integer,
        Type::NUMERIC | Type::MONEY => ValueKind::Decimal,
        Type::FLOAT4 | Type::FLOAT8 => ValueKind::Float,
        Type::DATE => ValueKind::Date,
        Type::TIME | Type::TIMETZ => ValueKind::Time,
        Type::TIMESTAMP => ValueKind::Timestamp,
        Type::TIMESTAMPTZ => ValueKind::Timestamptz,
        Type::INTERVAL => ValueKind::Interval,
        Type::BYTEA => ValueKind::Binary,
        Type::JSON | Type::JSONB => ValueKind::Json,
        Type::XML => ValueKind::Xml,
        Type::UUID => ValueKind::Uuid,
        Type::TEXT | Type::VARCHAR | Type::BPCHAR | Type::NAME | Type::CHAR | Type::UNKNOWN => {
            ValueKind::Text
        }
        _ if matches!(ty.name(), "geometry" | "geography") => ValueKind::Spatial,
        _ if ty.name() == "citext" => ValueKind::Text,
        _ => ValueKind::Other,
    }
}

/// Where a column of a result comes from: schema, table, column and whether it is part of
/// the table's primary key.
#[derive(Clone)]
pub(crate) struct Source {
    pub schema: String,
    pub table: String,
    pub column: String,
    pub key: bool,
}

/// The columns of a result, with the table each one comes from when the server says.
pub(crate) fn columns(
    columns: &[PgColumn],
    source: &dyn Fn(u32, i16) -> Option<Source>,
) -> Vec<Column> {
    columns
        .iter()
        .map(|column| {
            let mut described = Column::new(
                column.name(),
                column.type_().name(),
                kind_of(column.type_()),
            );
            if let (Some(table), Some(position)) = (column.table_oid(), column.column_id())
                && let Some(source) = source(table, position)
            {
                described.key = source.key;
                described.origin = Some(Origin {
                    schema: Some(source.schema),
                    table: source.table,
                    column: source.column,
                });
            }
            described
        })
        .collect()
}

fn text(raw: &[u8]) -> Decoded<String> {
    Ok(wire::text_from_sql(raw)?.to_owned())
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

/// An array literal of PostgreSQL (`{1,2,NULL}`), for values that are not plain items.
pub(super) fn literal(value: &Value) -> String {
    match value {
        Value::Null => "NULL".into(),
        Value::Bool(value) => value.to_string(),
        Value::Integer(value) => value.to_string(),
        Value::Float(value) => value.to_string(),
        Value::Text(text) | Value::Typed { text, .. } => text.clone(),
        Value::Array(items) => {
            let items: Vec<String> = items.iter().map(literal).collect();
            format!("{{{}}}", items.join(","))
        }
    }
}

/// A value of type `ty` from its binary form.
pub(crate) fn decode(ty: &Type, raw: &[u8]) -> Decoded<Value> {
    let typed = |kind, text: String| Value::typed(kind, text);
    match ty.kind() {
        Kind::Domain(base) => return decode(base, raw),
        Kind::Enum(_) => return Ok(Value::Text(text(raw)?)),
        Kind::Array(item) => {
            let array = wire::array_from_sql(raw)?;
            let lengths: Vec<i32> = array.dimensions().map(|d| Ok(d.len)).collect()?;
            let items: Vec<Value> = array
                .values()
                .map(|value| {
                    Ok(value
                        .map(|raw| decode(item, raw))
                        .transpose()?
                        .unwrap_or(Value::Null))
                })
                .collect()?;
            return Ok(nest(items, &lengths));
        }
        Kind::Range(item) => return range(item, raw).map(|text| typed(ValueKind::Other, text)),
        Kind::Composite(fields) => {
            return composite(fields, raw).map(|text| typed(ValueKind::Other, text));
        }
        _ => {}
    }
    Ok(match *ty {
        Type::BOOL => Value::Bool(wire::bool_from_sql(raw)?),
        Type::INT2 => Value::Integer(wire::int2_from_sql(raw)?.into()),
        Type::INT4 => Value::Integer(wire::int4_from_sql(raw)?.into()),
        Type::INT8 => Value::Integer(wire::int8_from_sql(raw)?),
        Type::OID => Value::Integer(wire::oid_from_sql(raw)?.into()),
        Type::FLOAT4 => Value::Float(wire::float4_from_sql(raw)?.into()),
        Type::FLOAT8 => Value::Float(wire::float8_from_sql(raw)?),
        Type::NUMERIC => typed(ValueKind::Decimal, numbers::numeric(raw)?),
        Type::MONEY => typed(ValueKind::Decimal, numbers::money(raw)?),
        Type::DATE => typed(ValueKind::Date, time::date(raw)?),
        Type::TIME => typed(ValueKind::Time, time::time(raw)?),
        Type::TIMETZ => typed(ValueKind::Time, time::timetz(raw)?),
        Type::TIMESTAMP => typed(ValueKind::Timestamp, time::timestamp(raw)?),
        Type::TIMESTAMPTZ => typed(ValueKind::Timestamptz, time::timestamptz(raw)?),
        Type::INTERVAL => typed(ValueKind::Interval, time::interval(raw)?),
        Type::BYTEA => Value::bytes(wire::bytea_from_sql(raw)),
        Type::JSON => typed(ValueKind::Json, text(raw)?),
        // jsonb starts with the version of its format.
        Type::JSONB => typed(ValueKind::Json, text(raw.get(1..).unwrap_or_default())?),
        Type::XML => typed(ValueKind::Xml, text(raw)?),
        Type::UUID => typed(
            ValueKind::Uuid,
            uuid::Uuid::from_bytes(wire::uuid_from_sql(raw)?).to_string(),
        ),
        Type::CHAR => Value::Text(char::from(wire::char_from_sql(raw)? as u8).to_string()),
        Type::INET | Type::CIDR => {
            let inet = wire::inet_from_sql(raw)?;
            let full = match inet.addr() {
                IpAddr::V4(_) => 32,
                IpAddr::V6(_) => 128,
            };
            let text = if inet.netmask() == full && *ty == Type::INET {
                inet.addr().to_string()
            } else {
                format!("{}/{}", inet.addr(), inet.netmask())
            };
            typed(ValueKind::Other, text)
        }
        Type::MACADDR => {
            let bytes = wire::macaddr_from_sql(raw)?;
            let parts: Vec<String> = bytes.iter().map(|byte| format!("{byte:02x}")).collect();
            typed(ValueKind::Other, parts.join(":"))
        }
        Type::BIT | Type::VARBIT => {
            let bits = wire::varbit_from_sql(raw)?;
            let text = (0..bits.len())
                .map(|index| {
                    if bits.bytes()[index / 8] & (0x80 >> (index % 8)) != 0 {
                        '1'
                    } else {
                        '0'
                    }
                })
                .collect();
            typed(ValueKind::Other, text)
        }
        Type::POINT => {
            let point = wire::point_from_sql(raw)?;
            typed(ValueKind::Other, format!("({},{})", point.x(), point.y()))
        }
        Type::TEXT | Type::VARCHAR | Type::BPCHAR | Type::NAME | Type::UNKNOWN => {
            Value::Text(text(raw)?)
        }
        _ if ty.name() == "citext" => Value::Text(text(raw)?),
        _ if ty.name() == "hstore" => {
            let pairs: Vec<String> = wire::hstore_from_sql(raw)?
                .map(|(key, value)| {
                    let quote = |text: &str| {
                        format!("\"{}\"", text.replace('\\', "\\\\").replace('"', "\\\""))
                    };
                    Ok(format!(
                        "{}=>{}",
                        quote(key),
                        value.map_or("NULL".into(), quote)
                    ))
                })
                .collect()?;
            typed(ValueKind::Other, pairs.join(", "))
        }
        // PostGIS sends EWKB; its text form is that in hexadecimal, in capitals.
        _ if matches!(ty.name(), "geometry" | "geography") => {
            typed(ValueKind::Spatial, hex(raw).to_uppercase())
        }
        // A type without a known binary form: its bytes, which nothing reads as something else.
        _ => typed(ValueKind::Other, format!("\\x{}", hex(raw))),
    })
}

/// The values of a row, cut to the size the interface takes at once.
pub(crate) fn row(row: &Row) -> Vec<Value> {
    (0..row.len())
        .map(|index| {
            let ty = row.columns()[index].type_();
            match row.try_get::<_, Option<Raw>>(index) {
                Ok(None) => Value::Null,
                Ok(Some(Raw(raw))) => decode(ty, raw).unwrap_or_else(|error| {
                    Value::typed(
                        ValueKind::Other,
                        format!("(unreadable {}: {error})", ty.name()),
                    )
                }),
                Err(error) => Value::typed(ValueKind::Other, format!("(unreadable: {error})")),
            }
            .truncated(limits::VALUE_BYTES)
        })
        .collect()
}
