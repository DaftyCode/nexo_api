//! Values made of other values: arrays in their dimensions, ranges and composites.
use super::{Decoded, decode, literal};
use nexo_driver_sdk::Value;
use postgres_protocol::types as wire;
use tokio_postgres::types::Type;

/// A flat list of values in the dimensions of an array.
pub(super) fn nest(items: Vec<Value>, lengths: &[i32]) -> Value {
    if lengths.len() <= 1 {
        return Value::Array(items);
    }
    let size: usize = lengths[1..].iter().map(|length| *length as usize).product();
    let chunks: Vec<Value> = items
        .chunks(size.max(1))
        .map(|chunk| nest(chunk.to_vec(), &lengths[1..]))
        .collect();
    Value::Array(chunks)
}

pub(super) fn range(item: &Type, raw: &[u8]) -> Decoded<String> {
    use wire::{Range, RangeBound};
    Ok(match wire::range_from_sql(raw)? {
        Range::Empty => "empty".into(),
        Range::Nonempty(lower, upper) => {
            let bound = |bound: RangeBound<Option<&[u8]>>| -> Decoded<(bool, String)> {
                Ok(match bound {
                    RangeBound::Inclusive(value) => (
                        true,
                        value
                            .map(|raw| decode(item, raw))
                            .transpose()?
                            .map(|v| literal(&v))
                            .unwrap_or_default(),
                    ),
                    RangeBound::Exclusive(value) => (
                        false,
                        value
                            .map(|raw| decode(item, raw))
                            .transpose()?
                            .map(|v| literal(&v))
                            .unwrap_or_default(),
                    ),
                    RangeBound::Unbounded => (false, String::new()),
                })
            };
            let ((low_in, low), (high_in, high)) = (bound(lower)?, bound(upper)?);
            format!(
                "{}{low},{high}{}",
                if low_in { '[' } else { '(' },
                if high_in { ']' } else { ')' }
            )
        }
    })
}

/// A composite: its fields' values, in its text form `(a,b)`.
pub(super) fn composite(fields: &[tokio_postgres::types::Field], raw: &[u8]) -> Decoded<String> {
    let count = i32::from_be_bytes(raw.get(..4).ok_or("a composite too short")?.try_into()?);
    let mut at = 4;
    let mut parts = Vec::new();
    for index in 0..count.max(0) as usize {
        let length = i32::from_be_bytes(
            raw.get(at + 4..at + 8)
                .ok_or("a composite too short")?
                .try_into()?,
        );
        at += 8;
        if length < 0 {
            parts.push(String::new());
            continue;
        }
        let value = raw
            .get(at..at + length as usize)
            .ok_or("a composite too short")?;
        at += length as usize;
        let field = fields
            .get(index)
            .ok_or("a composite with more fields than its type")?;
        parts.push(literal(&decode(field.type_(), value)?));
    }
    Ok(format!("({})", parts.join(",")))
}
